import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationBroker } from "../src/coordination/broker.js";

const roots: string[] = [];
const brokers = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factorio-coordination-"));
  roots.push(root);
  return [new CoordinationBroker("test", root), new CoordinationBroker("test", root)] as const;
};
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe("CoordinationBroker", () => {
  it("atomically gives concurrent workers different jobs", async () => {
    const [a, b] = brokers();
    const coordinator = await a.registerAgent({ name: "Lead", role: "coordinator" });
    const workerA = await a.registerAgent({ name: "Scout", role: "worker", capabilities: ["scan"] });
    const workerB = await b.registerAgent({ name: "Builder", role: "worker", capabilities: ["build"] });
    await a.submitJobs(coordinator.id, [
      { key: "scan", title: "Scan", instructions: "scan area", capability: "scan" },
      { key: "build", title: "Build", instructions: "build line", capability: "build" },
    ]);
    const [jobA, jobB] = await Promise.all([a.claimJob(workerA.id), b.claimJob(workerB.id)]);
    expect(jobA?.title).toBe("Scan");
    expect(jobB?.title).toBe("Build");
    expect(jobA?.id).not.toBe(jobB?.id);
  });

  it("wakes the coordinator with terminal job events exactly once", async () => {
    const [broker] = brokers();
    const coordinator = await broker.registerAgent({ name: "Coordinator", role: "coordinator" });
    const worker = await broker.registerAgent({ name: "Builder", role: "worker" });
    await broker.submitJobs(coordinator.id, [
      { key: "iron", title: "Automate iron", instructions: "Build one closed loop" },
    ]);
    const job = await broker.claimJob(worker.id);
    await broker.finishJob(worker.id, job!.id, "8 drills and 12 furnaces working");

    await expect(broker.takeCoordinationEvents(coordinator.id)).resolves.toMatchObject([
      { kind: "job_done", jobId: job!.id, text: "8 drills and 12 furnaces working" },
    ]);
    await expect(broker.takeCoordinationEvents(coordinator.id)).resolves.toEqual([]);
  });

  it("lets a coordinator take over a ready job when spawning a worker fails", async () => {
    const [broker] = brokers();
    const coordinator = await broker.registerAgent({ name: "Coordinator", role: "coordinator" });
    const [submitted] = await broker.submitJobs(coordinator.id, [
      { title: "Bootstrap coal", instructions: "Build one working coal loop" },
    ]);
    const job = await broker.takeoverJob(coordinator.id, submitted!.id);
    expect(job).toMatchObject({ status: "claimed", assignedAgent: coordinator.id });
    await broker.finishJob(coordinator.id, job.id, "coal is moving into a chest");
    await expect(broker.takeCoordinationEvents(coordinator.id)).resolves.toMatchObject([
      { kind: "job_done", jobId: job.id },
    ]);
  });

  it("waits for dependencies and deduplicates idempotent submissions", async () => {
    const [broker] = brokers();
    const coordinator = await broker.registerAgent({ name: "Lead", role: "coordinator" });
    const worker = await broker.registerAgent({ name: "Worker", role: "worker" });
    const submitted = await broker.submitJobs(coordinator.id, [
      { key: "first", title: "First", instructions: "first", idempotencyKey: "goal:first" },
      { key: "second", title: "Second", instructions: "second", dependsOn: ["first"] },
    ]);
    const duplicate = await broker.submitJobs(coordinator.id, [
      { title: "Duplicate", instructions: "ignored", idempotencyKey: "goal:first" },
    ]);
    expect(duplicate[0]?.id).toBe(submitted[0]?.id);
    const first = await broker.claimJob(worker.id);
    expect(first?.title).toBe("First");
    await broker.finishJob(worker.id, first!.id, "done");
    expect((await broker.claimJob(worker.id))?.title).toBe("Second");
  });

  it("enforces exclusive companion leases and area reservations", async () => {
    const [a, b] = brokers();
    const workerA = await a.registerAgent({ name: "A", role: "worker" });
    const workerB = await b.registerAgent({ name: "B", role: "worker" });
    await a.leaseCompanion(workerA.id, "Anna");
    await expect(b.leaseCompanion(workerB.id, "Anna")).rejects.toThrow(/leased by A/);
    await expect(a.assertMayAct(workerA.id, "Anna")).resolves.toBeUndefined();
    await expect(b.assertMayAct(workerB.id, "Anna")).rejects.toThrow(/must lease/);

    await a.reserveArea({ agentId: workerA.id, label: "smelter", center: { x: 0, y: 0 }, radius: 10 });
    await expect(b.reserveArea({ agentId: workerB.id, label: "power", center: { x: 15, y: 0 }, radius: 10 })).rejects.toThrow(/overlaps/);
    await expect(b.reserveArea({ agentId: workerB.id, label: "power", center: { x: 30, y: 0 }, radius: 5 })).resolves.toMatchObject({ label: "power" });
  });
});
