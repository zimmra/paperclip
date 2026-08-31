import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  adoptRunSourceIssue,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cross-issue influence limit PostgreSQL serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-issue-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows exactly one of concurrent attempts 20 and 21", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Concurrent Coder",
      role: "engineer",
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
      responsibleUserId: "board-user",
      contextSnapshot: { issueId: sourceIssueId },
    });
    await db.insert(activityLog).values(
      Array.from({ length: 18 }, () => ({
        companyId,
        actorType: "agent" as const,
        actorId: agentId,
        agentId,
        runId,
        action: "issue.cross_issue_influence_observed",
        entityType: "issue",
        entityId: targetIssueId,
      })),
    );

    const input = {
      companyId,
      runId,
      agentId,
      targetIssueId,
      targetIssueIdentifier: "CAP-2",
      kind: "comment" as const,
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    };
    // A comment, a PATCH, and an issue-thread interaction resolution race for the
    // last slot of the shared budget: the row lock must let exactly one of 19/20
    // through per attempt and fail the twenty-first closed.
    const decisions = await Promise.all([
      observeCrossIssueInfluence(db, input),
      observeCrossIssueInfluence(db, { ...input, kind: "update" }),
      observeCrossIssueInfluence(db, { ...input, kind: "interaction_resolution" }),
    ]);

    expect(decisions.map((decision) => decision?.allowed).sort()).toEqual([false, true, true]);
    expect(decisions.map((decision) => decision?.count).sort((a, b) => Number(a) - Number(b)))
      .toEqual([19, 20, 21]);

    const recorded = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_observed")).toHaveLength(20);
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_cap_rejected")).toHaveLength(1);
  });

  describe("adopting a checked-out issue as the run source", () => {
    async function seedRun(contextSnapshot: Record<string, unknown> | null) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Timer Ticker",
        role: "engineer",
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
        responsibleUserId: "board-user",
        contextSnapshot,
      });

      return { companyId, agentId, runId };
    }

    function readSnapshot(runId: string) {
      return db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]?.contextSnapshot ?? null);
    }

    it("scopes an unscoped timer run and unblocks its same-issue writes", async () => {
      const { companyId, agentId, runId } = await seedRun({ reason: "heartbeat_timer", source: "timer" });
      const issueId = randomUUID();
      const observeInput = {
        companyId,
        runId,
        agentId,
        targetIssueId: issueId,
        kind: "comment" as const,
        now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
      };

      await expect(observeCrossIssueInfluence(db, observeInput)).rejects.toMatchObject({
        status: 403,
        details: { code: "cross_issue_influence_run_context_required" },
      });

      await expect(adoptRunSourceIssue(db, { companyId, runId, agentId, issueId })).resolves.toBe("adopted");
      expect(await readSnapshot(runId)).toEqual({
        reason: "heartbeat_timer",
        source: "timer",
        issueId,
        issueIdSource: "issue.checkout",
      });

      // Same-issue writes are now the run's own work: allowed and uncounted.
      await expect(observeCrossIssueInfluence(db, observeInput)).resolves.toBeNull();
      // Everyone else's issues stay on the shared per-run budget.
      await expect(observeCrossIssueInfluence(db, { ...observeInput, targetIssueId: randomUUID() }))
        .resolves.toMatchObject({ allowed: true, count: 1, mode: "enforce" });
    });

    it("scopes a run whose context snapshot is absent entirely", async () => {
      const { companyId, agentId, runId } = await seedRun(null);
      const issueId = randomUUID();

      await expect(adoptRunSourceIssue(db, { companyId, runId, agentId, issueId })).resolves.toBe("adopted");
      expect(await readSnapshot(runId)).toEqual({ issueId, issueIdSource: "issue.checkout" });
    });

    it.each(["issueId", "taskId"] as const)(
      "leaves a run already scoped by %s untouched",
      async (scopeKey) => {
        const snapshot = { [scopeKey]: randomUUID(), source: "issue.assignment" };
        const { companyId, agentId, runId } = await seedRun(snapshot);

        await expect(adoptRunSourceIssue(db, { companyId, runId, agentId, issueId: randomUUID() }))
          .resolves.toBe("already_scoped");
        expect(await readSnapshot(runId)).toEqual(snapshot);
      },
    );

    it.each(["runId", "agentId", "companyId"] as const)(
      "refuses to scope a run that does not match the caller's %s",
      async (field) => {
        const { companyId, agentId, runId } = await seedRun({ reason: "heartbeat_timer" });
        const input = { companyId, runId, agentId, issueId: randomUUID() };
        // A malformed run id must fail before it can reach a PostgreSQL cast.
        input[field] = field === "runId" ? "attacker-controlled-run-id" : randomUUID();

        await expect(adoptRunSourceIssue(db, input)).resolves.toBe("run_unavailable");
        expect(await readSnapshot(runId)).toEqual({ reason: "heartbeat_timer" });
      },
    );
  });
});
