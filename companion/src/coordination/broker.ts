import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config.js";
import { atomicWriteFile } from "../setup/atomic.js";

export type AgentRole = "coordinator" | "worker";
export type JobStatus = "queued" | "claimed" | "done" | "failed";

export interface CoordinationAgent {
  id: string;
  name: string;
  role: AgentRole;
  capabilities: string[];
  createdAt: number;
  lastSeen: number;
}

export interface CoordinationJob {
  id: string;
  key?: string;
  title: string;
  instructions: string;
  status: JobStatus;
  priority: number;
  capability?: string;
  companion?: string;
  dependsOn: string[];
  idempotencyKey?: string;
  assignedAgent?: string;
  claimExpiresAt?: number;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CompanionLease {
  companion: string;
  agentId: string;
  expiresAt: number;
}

export interface AreaReservation {
  id: string;
  agentId: string;
  label: string;
  center: { x: number; y: number };
  radius: number;
  expiresAt: number;
}

interface AgentCursor {
  chatId: number;
  eventId: number;
  initialized: boolean;
}

interface CoordinationState {
  version: 1;
  agents: Record<string, CoordinationAgent>;
  jobs: Record<string, CoordinationJob>;
  leases: Record<string, CompanionLease>;
  reservations: Record<string, AreaReservation>;
  cursors: Record<string, AgentCursor>;
}

export interface SubmitJobInput {
  key?: string;
  title: string;
  instructions: string;
  priority?: number;
  capability?: string;
  companion?: string;
  dependsOn?: string[];
  idempotencyKey?: string;
}

const emptyState = (): CoordinationState => ({
  version: 1,
  agents: {},
  jobs: {},
  leases: {},
  reservations: {},
  cursors: {},
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CoordinationBroker {
  private readonly stateFile: string;
  private readonly lockDir: string;

  constructor(scope: string, root = path.join(configDir(), "coordination")) {
    const safeScope = scope.replace(/[^a-zA-Z0-9_.-]/g, "_");
    this.stateFile = path.join(root, `${safeScope}.json`);
    this.lockDir = path.join(root, `${safeScope}.lock`);
  }

  async registerAgent(input: {
    name: string;
    role: AgentRole;
    capabilities?: string[];
    agentId?: string;
  }): Promise<CoordinationAgent> {
    return this.mutate((state) => {
      const now = Date.now();
      const id = input.agentId ?? `agent-${crypto.randomUUID()}`;
      const existing = state.agents[id];
      const agent: CoordinationAgent = {
        id,
        name: input.name,
        role: input.role,
        capabilities: [...new Set(input.capabilities ?? existing?.capabilities ?? [])],
        createdAt: existing?.createdAt ?? now,
        lastSeen: now,
      };
      state.agents[id] = agent;
      state.cursors[id] ??= { chatId: 0, eventId: 0, initialized: false };
      return agent;
    });
  }

  async heartbeat(agentId: string): Promise<CoordinationAgent> {
    return this.mutate((state) => {
      const agent = this.touchAgent(state, agentId);
      for (const job of Object.values(state.jobs)) {
        if (job.status === "claimed" && job.assignedAgent === agentId) {
          job.claimExpiresAt = Date.now() + 10 * 60 * 1000;
        }
      }
      return agent;
    });
  }

  async submitJobs(coordinatorId: string, inputs: SubmitJobInput[]): Promise<CoordinationJob[]> {
    return this.mutate((state) => {
      const coordinator = this.touchAgent(state, coordinatorId);
      if (coordinator.role !== "coordinator") throw new Error("only a coordinator can submit jobs");
      const now = Date.now();
      const keyToId = new Map<string, string>();
      for (const input of inputs) {
        if (input.key) keyToId.set(input.key, `job-${crypto.randomUUID()}`);
      }
      const created: CoordinationJob[] = [];
      for (const input of inputs) {
        const duplicate = input.idempotencyKey
          ? Object.values(state.jobs).find((job) => job.idempotencyKey === input.idempotencyKey)
          : undefined;
        if (duplicate) {
          created.push(duplicate);
          if (input.key) keyToId.set(input.key, duplicate.id);
          continue;
        }
        const id = input.key ? keyToId.get(input.key)! : `job-${crypto.randomUUID()}`;
        const job: CoordinationJob = {
          id,
          key: input.key,
          title: input.title,
          instructions: input.instructions,
          status: "queued",
          priority: input.priority ?? 0,
          capability: input.capability,
          companion: input.companion,
          dependsOn: (input.dependsOn ?? []).map((dependency) => keyToId.get(dependency) ?? dependency),
          idempotencyKey: input.idempotencyKey,
          createdAt: now,
          updatedAt: now,
        };
        state.jobs[id] = job;
        created.push(job);
      }
      for (const job of created) {
        for (const dependency of job.dependsOn) {
          if (!state.jobs[dependency]) throw new Error(`job ${job.key ?? job.id} depends on unknown job ${dependency}`);
        }
      }
      return created;
    });
  }

  async claimJob(agentId: string): Promise<CoordinationJob | null> {
    return this.mutate((state) => {
      const agent = this.touchAgent(state, agentId);
      if (agent.role !== "worker") throw new Error("only a worker can claim jobs");
      const ready = Object.values(state.jobs)
        .filter((job) => job.status === "queued")
        .filter((job) => !job.capability || agent.capabilities.includes(job.capability))
        .filter((job) => job.dependsOn.every((id) => state.jobs[id]?.status === "done"))
        .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      const job = ready[0];
      if (!job) return null;
      job.status = "claimed";
      job.assignedAgent = agentId;
      job.claimExpiresAt = Date.now() + 10 * 60 * 1000;
      job.updatedAt = Date.now();
      return job;
    });
  }

  async finishJob(agentId: string, jobId: string, result: string): Promise<CoordinationJob> {
    return this.setJobTerminal(agentId, jobId, "done", result);
  }

  async failJob(agentId: string, jobId: string, error: string, retry: boolean): Promise<CoordinationJob> {
    return this.mutate((state) => {
      const job = this.ownedJob(state, agentId, jobId);
      job.status = retry ? "queued" : "failed";
      job.error = error;
      job.assignedAgent = retry ? undefined : agentId;
      job.claimExpiresAt = undefined;
      job.updatedAt = Date.now();
      return job;
    });
  }

  async leaseCompanion(agentId: string, companion: string, ttlSeconds = 300): Promise<CompanionLease> {
    return this.mutate((state) => {
      const agent = this.touchAgent(state, agentId);
      if (agent.role !== "worker") throw new Error("only a worker can lease a companion");
      const current = state.leases[companion];
      if (current && current.agentId !== agentId) {
        throw new Error(`${companion} is leased by ${state.agents[current.agentId]?.name ?? current.agentId}`);
      }
      const lease = { companion, agentId, expiresAt: Date.now() + ttlSeconds * 1000 };
      state.leases[companion] = lease;
      return lease;
    });
  }

  async releaseCompanion(agentId: string, companion: string): Promise<void> {
    await this.mutate((state) => {
      const current = state.leases[companion];
      if (current && current.agentId !== agentId) throw new Error(`${companion} is leased by another agent`);
      delete state.leases[companion];
    });
  }

  async assertMayAct(agentId: string, companion: string): Promise<void> {
    await this.mutate((state) => {
      const agent = this.touchAgent(state, agentId);
      if (agent.role === "coordinator") return;
      const lease = state.leases[companion];
      if (!lease || lease.agentId !== agentId) {
        throw new Error(`worker ${agent.name} must lease companion ${companion} before using action tools`);
      }
    });
  }

  async reserveArea(input: {
    agentId: string;
    label: string;
    center: { x: number; y: number };
    radius: number;
    ttlSeconds?: number;
  }): Promise<AreaReservation> {
    return this.mutate((state) => {
      this.touchAgent(state, input.agentId);
      const conflict = Object.values(state.reservations).find((reservation) => {
        if (reservation.agentId === input.agentId) return false;
        const dx = reservation.center.x - input.center.x;
        const dy = reservation.center.y - input.center.y;
        return Math.hypot(dx, dy) < reservation.radius + input.radius;
      });
      if (conflict) throw new Error(`area overlaps reservation "${conflict.label}" by ${state.agents[conflict.agentId]?.name ?? conflict.agentId}`);
      const reservation: AreaReservation = {
        id: `area-${crypto.randomUUID()}`,
        agentId: input.agentId,
        label: input.label,
        center: input.center,
        radius: input.radius,
        expiresAt: Date.now() + (input.ttlSeconds ?? 300) * 1000,
      };
      state.reservations[reservation.id] = reservation;
      return reservation;
    });
  }

  async releaseArea(agentId: string, reservationId: string): Promise<void> {
    await this.mutate((state) => {
      const reservation = state.reservations[reservationId];
      if (reservation && reservation.agentId !== agentId) throw new Error("reservation belongs to another agent");
      delete state.reservations[reservationId];
    });
  }

  async cursor(agentId: string): Promise<{ agent: CoordinationAgent; cursor: AgentCursor; companions: string[] }> {
    return this.mutate((state) => {
      const agent = this.touchAgent(state, agentId);
      const cursor = state.cursors[agentId] ??= { chatId: 0, eventId: 0, initialized: false };
      const companions = Object.values(state.leases).filter((lease) => lease.agentId === agentId).map((lease) => lease.companion);
      return { agent, cursor, companions };
    });
  }

  async updateCursor(agentId: string, input: Partial<AgentCursor>): Promise<void> {
    await this.mutate((state) => {
      this.touchAgent(state, agentId);
      const cursor = state.cursors[agentId] ??= { chatId: 0, eventId: 0, initialized: false };
      Object.assign(cursor, input);
    });
  }

  async snapshot() {
    return this.mutate((state) => ({
      agents: Object.values(state.agents),
      jobs: Object.values(state.jobs),
      leases: Object.values(state.leases),
      reservations: Object.values(state.reservations),
    }));
  }

  async reset(): Promise<void> {
    await this.mutate((state) => Object.assign(state, emptyState()));
  }

  private async setJobTerminal(agentId: string, jobId: string, status: "done" | "failed", text: string) {
    return this.mutate((state) => {
      const job = this.ownedJob(state, agentId, jobId);
      job.status = status;
      if (status === "done") job.result = text;
      else job.error = text;
      job.claimExpiresAt = undefined;
      job.updatedAt = Date.now();
      return job;
    });
  }

  private ownedJob(state: CoordinationState, agentId: string, jobId: string): CoordinationJob {
    this.touchAgent(state, agentId);
    const job = state.jobs[jobId];
    if (!job) throw new Error(`unknown job ${jobId}`);
    if (job.assignedAgent !== agentId) throw new Error(`job ${jobId} is not assigned to this agent`);
    if (job.status !== "claimed") throw new Error(`job ${jobId} is ${job.status}, not claimed`);
    return job;
  }

  private touchAgent(state: CoordinationState, agentId: string): CoordinationAgent {
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`unknown agent ${agentId}; call register_factorio_agent first`);
    agent.lastSeen = Date.now();
    return agent;
  }

  private prune(state: CoordinationState): void {
    const now = Date.now();
    for (const [name, lease] of Object.entries(state.leases)) if (lease.expiresAt <= now) delete state.leases[name];
    for (const [id, reservation] of Object.entries(state.reservations)) if (reservation.expiresAt <= now) delete state.reservations[id];
    for (const job of Object.values(state.jobs)) {
      if (job.status === "claimed" && (job.claimExpiresAt ?? 0) <= now) {
        job.status = "queued";
        job.assignedAgent = undefined;
        job.claimExpiresAt = undefined;
        job.updatedAt = now;
        job.error = "worker claim expired; returned to queue";
      }
    }
  }

  private readState(): CoordinationState {
    if (!fs.existsSync(this.stateFile)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as CoordinationState;
    if (parsed.version !== 1 || !parsed.agents || !parsed.jobs) throw new Error(`invalid coordination state at ${this.stateFile}`);
    return parsed;
  }

  private async mutate<T>(operation: (state: CoordinationState) => T): Promise<T> {
    await this.acquireLock();
    try {
      const state = this.readState();
      this.prune(state);
      const result = operation(state);
      atomicWriteFile(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
      return result;
    } finally {
      fs.rmSync(this.lockDir, { recursive: true, force: true });
    }
  }

  private async acquireLock(): Promise<void> {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        fs.mkdirSync(this.lockDir);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const stat = fs.statSync(this.lockDir);
          if (Date.now() - stat.mtimeMs > 10_000) {
            fs.rmSync(this.lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        await pause(20);
      }
    }
    throw new Error("coordination broker lock timed out");
  }
}
