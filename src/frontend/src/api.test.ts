import { afterEach, describe, expect, it, vi } from "vitest";
import { Api } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe("attribution info", () => {
  it("asks again after a failed request instead of keeping the failure", async () => {
    const fetch = vi.fn().mockReturnValueOnce(Promise.resolve(new Response("", { status: 502 }))).mockReturnValueOnce(ok({ available: true, disclaimer: "d", categories: [], sources: {} }));
    vi.stubGlobal("fetch", fetch);
    const api = new Api();
    expect((await api.attribution()).available).toBe(false);
    expect((await api.attribution()).available).toBe(true);
  });

  it("gives up on a request that hangs, so the events still load", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")))));
    const pending = new Api().attribution();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).available).toBe(false);
  });
});
