import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jest } from "@jest/globals";
import { getDeployTokensHandler } from "./admin-deploy-token.js";

const ORIGINAL_STATE_DIR = process.env.STATE_DIR;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carkedit-deploy-token-test-"));
  process.env.STATE_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_STATE_DIR === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = ORIGINAL_STATE_DIR;
});

function mockRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
    set(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
  };
  return res;
}

function writeApiToken(value: string) {
  fs.writeFileSync(path.join(tmpDir, ".deploy-token-carkedit-api"), value);
}

function writeOnlineToken(value: string) {
  fs.writeFileSync(path.join(tmpDir, ".deploy-token-carkedit-online"), value);
}

describe("getDeployTokensHandler", () => {
  it("returns 503 when both token files are missing", () => {
    const res = mockRes();
    getDeployTokensHandler({}, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "deploy_tokens_not_provisioned" });
  });

  it("returns 503 when only the api token file is missing", () => {
    writeOnlineToken("online-token-value");
    const res = mockRes();
    getDeployTokensHandler({}, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "deploy_tokens_not_provisioned" });
  });

  it("returns 503 when only the online token file is missing", () => {
    writeApiToken("api-token-value");
    const res = mockRes();
    getDeployTokensHandler({}, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "deploy_tokens_not_provisioned" });
  });

  it("returns 503 when a token file is empty", () => {
    writeApiToken("");
    writeOnlineToken("online-token-value");
    const res = mockRes();
    getDeployTokensHandler({}, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "deploy_tokens_not_provisioned" });
  });

  it("returns 503 when a token file is whitespace-only", () => {
    writeApiToken("api-token-value");
    writeOnlineToken("   \n\t  \n");
    const res = mockRes();
    getDeployTokensHandler({}, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "deploy_tokens_not_provisioned" });
  });

  it("returns 200 with both tokens when both files exist", () => {
    writeApiToken("api-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    writeOnlineToken("online-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const res = mockRes();
    getDeployTokensHandler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      api: "api-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      online: "online-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  });

  it("strips trailing newlines (openssl rand -hex 32 > file pattern)", () => {
    writeApiToken("api-token-value\n");
    writeOnlineToken("online-token-value\n");
    const res = mockRes();
    getDeployTokensHandler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ api: "api-token-value", online: "online-token-value" });
  });

  it("sets Cache-Control: no-store on success", () => {
    writeApiToken("a");
    writeOnlineToken("b");
    const res = mockRes();
    getDeployTokensHandler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("does not include token contents in any logged error path", () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      writeApiToken("super-secret-token-must-not-leak");
      writeOnlineToken("online-token-value");
      fs.chmodSync(path.join(tmpDir, ".deploy-token-carkedit-api"), 0o000);

      const res = mockRes();
      getDeployTokensHandler({}, res);

      const allLogs = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allLogs).not.toContain("super-secret-token-must-not-leak");
    } finally {
      try {
        fs.chmodSync(path.join(tmpDir, ".deploy-token-carkedit-api"), 0o600);
      } catch {
        /* ignore */
      }
      errSpy.mockRestore();
    }
  });
});
