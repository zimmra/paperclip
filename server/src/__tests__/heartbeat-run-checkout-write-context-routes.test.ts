import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat-run write context route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * A plain periodic tick. The dispatcher stamps no `issueId`/`taskId`, which is
 * exactly the shape that used to make every issue write from the run fail the
 * cross-issue source gate — including writes to the issue it had checked out.
 */
const GENERIC_TIMER_CONTEXT_SNAPSHOT = {
  now: "2026-08-31T00:00:00.000Z",
  reason: "heartbeat_timer",
  source: "timer",
  wakeReason: "heartbeat_timer",
  wakeSource: "timer",
  timerClaimWasFirstHeartbeat: true,
};

describeEmbeddedPostgres("heartbeat run write context after checkout", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-write-context-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  async function seed(contextSnapshot: Record<string, unknown> | null) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Routine Product Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "timer",
      startedAt: new Date(),
      contextSnapshot,
    });

    return { companyId, agentId, runId };
  }

  async function seedIssue(
    companyId: string,
    agentId: string,
    overrides: { title: string; status?: "todo" | "in_progress"; checkoutRunId?: string | null },
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: overrides.title,
      status: overrides.status ?? "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: overrides.checkoutRunId ?? null,
      executionRunId: overrides.checkoutRunId ?? null,
    });
    return issueId;
  }

  function readSnapshot(runId: string) {
    return db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.contextSnapshot ?? null);
  }

  function countInfluence(companyId: string, runId: string, action: string) {
    return db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.runId, runId),
        eq(activityLog.action, action),
      ))
      .then((rows) => rows.length);
  }

  it("denies issue writes from a generic timer run that has not checked anything out", async () => {
    const { companyId, agentId, runId } = await seed(GENERIC_TIMER_CONTEXT_SNAPSHOT);
    const issueId = await seedIssue(companyId, agentId, { title: "Unscoped write" });
    const app = createApp(agentActor(companyId, agentId, runId));

    const comment = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Status update before checkout." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(403);
    expect(comment.body.details).toMatchObject({ code: "cross_issue_influence_run_context_required" });

    const patch = await request(app).patch(`/api/issues/${issueId}`).send({ title: "Renamed before checkout" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(403);
    expect(patch.body.details).toMatchObject({ code: "cross_issue_influence_run_context_required" });

    // The denial must not have quietly scoped the run to the issue it was refused.
    expect(readRunIssueId(await readSnapshot(runId))).toBeNull();
  });

  it("adopts the checked-out issue so the same run can then comment and update it", async () => {
    const { companyId, agentId, runId } = await seed(GENERIC_TIMER_CONTEXT_SNAPSHOT);
    const issueId = await seedIssue(companyId, agentId, { title: "Adopted at checkout" });
    const app = createApp(agentActor(companyId, agentId, runId));

    const checkout = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo", "in_progress"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

    const snapshot = await readSnapshot(runId) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      issueId,
      issueIdSource: "issue.checkout",
      // Adoption merges into the tick's own context rather than replacing it.
      reason: "heartbeat_timer",
      timerClaimWasFirstHeartbeat: true,
    });

    const comment = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Status update after checkout." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);

    const patch = await request(app).patch(`/api/issues/${issueId}`).send({ title: "Renamed after checkout" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.title).toBe("Renamed after checkout");

    // Same-issue writes are the run's own work, never cross-issue influence.
    expect(await countInfluence(companyId, runId, "issue.cross_issue_influence_observed")).toBe(0);
  });

  it("keeps writes to other issues counted against the cross-issue cap after adoption", async () => {
    const { companyId, agentId, runId } = await seed(GENERIC_TIMER_CONTEXT_SNAPSHOT);
    const checkedOutIssueId = await seedIssue(companyId, agentId, { title: "Adopted source" });
    const otherIssueId = await seedIssue(companyId, agentId, { title: "Someone else's issue" });
    const app = createApp(agentActor(companyId, agentId, runId));

    const checkout = await request(app)
      .post(`/api/issues/${checkedOutIssueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo", "in_progress"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

    const comment = await request(app)
      .post(`/api/issues/${otherIssueId}/comments`)
      .send({ body: "Cross-issue nudge." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);

    // Allowed but budgeted: adoption grants the run a source issue, not an
    // exemption from the per-run cap on influencing everyone else's issues.
    expect(await countInfluence(companyId, runId, "issue.cross_issue_influence_observed")).toBe(1);
  });

  it("does not let a second checkout relaunder an already-scoped run's source issue", async () => {
    const { companyId, agentId, runId } = await seed(null);
    const scopedIssueId = await seedIssue(companyId, agentId, { title: "Wake target" });
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: scopedIssueId, source: "issue.assignment" } })
      .where(eq(heartbeatRuns.id, runId));
    const secondIssueId = await seedIssue(companyId, agentId, { title: "Later checkout" });
    const app = createApp(agentActor(companyId, agentId, runId));

    const checkout = await request(app)
      .post(`/api/issues/${secondIssueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo", "in_progress"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

    // The issue-scoped wake keeps its source, so the second issue's writes stay
    // on the cap instead of resetting the run's scope to whatever it checks out.
    expect(await readSnapshot(runId)).toMatchObject({
      issueId: scopedIssueId,
      source: "issue.assignment",
    });

    const comment = await request(app)
      .post(`/api/issues/${secondIssueId}/comments`)
      .send({ body: "Second issue comment." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    expect(await countInfluence(companyId, runId, "issue.cross_issue_influence_observed")).toBe(1);
  });
});

function readRunIssueId(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  for (const candidate of [context.issueId, context.taskId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}
