import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge.js";
import { asArray, type GetChatResult, type GetEventsResult } from "../types.js";
import { CoordinationBroker } from "./broker.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const result = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  isError,
});
const attempt = async (operation: () => Promise<string>) => {
  try {
    return result(await operation());
  } catch (error) {
    return result(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
  }
};

export function registerCoordinationTools(
  server: McpServer,
  broker: CoordinationBroker,
  getBridge: () => Promise<Bridge>,
): void {
  server.registerTool("register_factorio_agent", {
    description: "Join the shared Factorio job broker as the one coordinator or as a worker subagent. Keep the returned agent_id and pass it to every coordination/action call.",
    inputSchema: z.object({
      name: z.string().min(1).max(40),
      role: z.enum(["coordinator", "worker"]),
      capabilities: z.array(z.string().min(1).max(30)).max(12).optional(),
      agent_id: z.string().min(8).max(100).optional().describe("reuse an earlier identity after reconnecting"),
    }),
  }, async ({ name, role, capabilities, agent_id }) => attempt(async () => {
    const agent = await broker.registerAgent({ name, role, capabilities, agentId: agent_id });
    return `Registered ${agent.role} ${agent.name}. agent_id=${agent.id}`;
  }));

  server.registerTool("coordinate_submit_jobs", {
    description: "Coordinator only: atomically submit a dependency graph of bounded Factorio jobs. Each job should produce one independently verifiable result in about 2-5 minutes, with exact area/input/output and a concrete definition of done. Dependencies may reference keys from the same call.",
    inputSchema: z.object({
      coordinator_id: z.string().min(8),
      jobs: z.array(z.object({
        key: z.string().min(1).max(40).optional(),
        title: z.string().min(1).max(120),
        instructions: z.string().min(1).max(2000),
        priority: z.number().int().min(-100).max(100).optional(),
        capability: z.string().max(30).optional(),
        companion: z.string().max(20).optional(),
        depends_on: z.array(z.string()).max(20).optional(),
        idempotency_key: z.string().min(1).max(100).optional(),
      })).min(1).max(30),
    }),
  }, async ({ coordinator_id, jobs }) => attempt(async () => {
    const submitted = await broker.submitJobs(coordinator_id, jobs.map((job) => ({
      ...job,
      dependsOn: job.depends_on,
      idempotencyKey: job.idempotency_key,
    })));
    return JSON.stringify({ jobs: submitted.map((job) => ({ id: job.id, key: job.key, title: job.title, status: job.status, depends_on: job.dependsOn })) });
  }));

  server.registerTool("coordinate_claim_job", {
    description: "Worker only: atomically claim the highest-priority ready job compatible with this worker. Returns no_job when nothing is ready.",
    inputSchema: z.object({ agent_id: z.string().min(8) }),
  }, async ({ agent_id }) => attempt(async () => {
    const job = await broker.claimJob(agent_id);
    return job ? JSON.stringify({ job }) : "no_job";
  }));

  server.registerTool("coordinate_takeover_job", {
    description: "Coordinator fallback: claim one specific ready job yourself when a native subagent could not start. Execute it directly, then call coordinate_complete_job or coordinate_fail_job with the coordinator id. Never steal a job already claimed by a live worker.",
    inputSchema: z.object({ coordinator_id: z.string().min(8), job_id: z.string().min(8) }),
  }, async ({ coordinator_id, job_id }) => attempt(async () => {
    const job = await broker.takeoverJob(coordinator_id, job_id);
    return JSON.stringify({ job });
  }));

  server.registerTool("coordinate_complete_job", {
    description: "Mark your claimed job complete and return concise verification evidence. Normally worker-only; a coordinator may use it after coordinate_takeover_job.",
    inputSchema: z.object({ agent_id: z.string().min(8), job_id: z.string().min(8), result: z.string().min(1).max(4000) }),
  }, async ({ agent_id, job_id, result: summary }) => attempt(async () => {
    const job = await broker.finishJob(agent_id, job_id, summary);
    return `Completed ${job.id}: ${job.title}`;
  }));

  server.registerTool("coordinate_fail_job", {
    description: "Fail your claimed job, optionally returning it to the ready queue. Normally worker-only; a coordinator may use it after coordinate_takeover_job.",
    inputSchema: z.object({ agent_id: z.string().min(8), job_id: z.string().min(8), error: z.string().min(1).max(2000), retry: z.boolean().optional() }),
  }, async ({ agent_id, job_id, error, retry }) => attempt(async () => {
    const job = await broker.failJob(agent_id, job_id, error, retry ?? false);
    return `Job ${job.id} is ${job.status}.`;
  }));

  server.registerTool("coordinate_heartbeat", {
    description: "Refresh an agent identity while it is working or waiting.",
    inputSchema: z.object({ agent_id: z.string().min(8) }),
  }, async ({ agent_id }) => attempt(async () => {
    const agent = await broker.heartbeat(agent_id);
    return `${agent.name} heartbeat recorded.`;
  }));

  server.registerTool("lease_companion", {
    description: "Worker only: take or renew an exclusive lease on one in-game companion before action calls.",
    inputSchema: z.object({ agent_id: z.string().min(8), companion: z.string().min(1).max(20), ttl_s: z.number().int().min(30).max(3600).optional() }),
  }, async ({ agent_id, companion, ttl_s }) => attempt(async () => {
    const lease = await broker.leaseCompanion(agent_id, companion, ttl_s);
    return `Leased ${lease.companion} until ${new Date(lease.expiresAt).toISOString()}.`;
  }));

  server.registerTool("release_companion", {
    description: "Release a companion lease after completing or abandoning a job.",
    inputSchema: z.object({ agent_id: z.string().min(8), companion: z.string().min(1).max(20) }),
  }, async ({ agent_id, companion }) => attempt(async () => {
    await broker.releaseCompanion(agent_id, companion);
    return `Released ${companion}.`;
  }));

  server.registerTool("reserve_build_area", {
    description: "Reserve a circular map area before a worker changes or builds there. Overlapping reservations by other workers are rejected.",
    inputSchema: z.object({
      agent_id: z.string().min(8), label: z.string().min(1).max(80),
      x: z.number(), y: z.number(), radius: z.number().min(1).max(100),
      ttl_s: z.number().int().min(30).max(3600).optional(),
    }),
  }, async ({ agent_id, label, x, y, radius, ttl_s }) => attempt(async () => {
    const reservation = await broker.reserveArea({ agentId: agent_id, label, center: { x, y }, radius, ttlSeconds: ttl_s });
    return `Reserved area ${reservation.id} around (${x}, ${y}), radius ${radius}.`;
  }));

  server.registerTool("release_build_area", {
    description: "Release a worker's build-area reservation.",
    inputSchema: z.object({ agent_id: z.string().min(8), reservation_id: z.string().min(8) }),
  }, async ({ agent_id, reservation_id }) => attempt(async () => {
    await broker.releaseArea(agent_id, reservation_id);
    return `Released reservation ${reservation_id}.`;
  }));

  server.registerTool("coordination_status", {
    description: "Show shared agents, jobs, companion leases and build-area reservations. Use concise results to coordinate workers.",
    inputSchema: z.object({}),
  }, async () => attempt(async () => JSON.stringify(await broker.snapshot())));

  server.registerTool("reset_coordination", {
    description: "Clear stale multi-agent coordination state. Use only before a fresh coordinated session, never while workers are active.",
    inputSchema: z.object({ confirm: z.literal(true) }),
  }, async () => attempt(async () => {
    await broker.reset();
    return "Coordination state cleared.";
  }));

  server.registerTool("wait_for_agent_events", {
    description: "Coordinated-mode event stream. Coordinators receive player chat, game events, and job completion/failure transitions; workers receive only game events for companions they lease. A coordinator must react to job transitions before waiting again.",
    inputSchema: z.object({ agent_id: z.string().min(8), timeout_s: z.number().int().min(1).max(21600).optional() }),
  }, async ({ agent_id, timeout_s }) => attempt(async () => {
    const timeout = timeout_s ?? 30;
    let registration = await broker.cursor(agent_id);
    const readyCoordination = await broker.takeCoordinationEvents(agent_id);
    if (readyCoordination.length > 0) {
      return readyCoordination.map((event) =>
        `[coordination:${event.kind}] ${event.title} (${event.jobId}): ${event.text}`,
      ).join("\n");
    }
    const bridge = await getBridge();
    if (!registration.cursor.initialized) {
      const chat = await bridge.call<GetChatResult>("get_chat", { since_id: 0 });
      const events = await bridge.call<GetEventsResult>("get_events", { since_id: 0 });
      await broker.updateCursor(agent_id, { chatId: chat.last_id, eventId: events.last_id, initialized: true });
      registration = await broker.cursor(agent_id);
    }
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      const lines: string[] = [];
      const coordinationEvents = await broker.takeCoordinationEvents(agent_id);
      lines.push(...coordinationEvents.map((event) =>
        `[coordination:${event.kind}] ${event.title} (${event.jobId}): ${event.text}`,
      ));
      if (lines.length > 0) return lines.join("\n");
      if (registration.agent.role === "coordinator") {
        const chat = await bridge.call<GetChatResult>("get_chat", { since_id: registration.cursor.chatId });
        registration.cursor.chatId = Math.max(registration.cursor.chatId, chat.last_id);
        lines.push(...asArray(chat.messages).map((message) => `[#${message.id}] <${message.player}> ${message.text}`));
      }
      const events = await bridge.call<GetEventsResult>("get_events", { since_id: registration.cursor.eventId });
      registration.cursor.eventId = Math.max(registration.cursor.eventId, events.last_id);
      const visibleEvents = asArray(events.events).filter((event) =>
        registration.agent.role === "coordinator" ||
        (event.companion !== undefined && registration.companions.includes(event.companion)),
      );
      lines.push(...visibleEvents.map((event) => `[event:${event.kind}] ${event.text}`));
      await broker.updateCursor(agent_id, registration.cursor);
      if (lines.length > 0) return lines.join("\n");
      await sleep(500);
      registration = await broker.cursor(agent_id);
    }
    return `No relevant events in ${timeout}s.`;
  }));
}
