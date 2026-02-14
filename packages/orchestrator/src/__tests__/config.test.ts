import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, getConfig, resetConfig } from "../config.js";

// Environment helper to set and restore env vars
function withEnv(env: Record<string, string>, fn: () => void): void {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    original[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const [key, val] of Object.entries(original)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  }
}

// Required env vars for valid config
const REQUIRED_ENV = {
  RUNPOD_ENDPOINT_ID: "test-endpoint-id",
  RUNPOD_API_KEY: "test-api-key",
  GIT_REPO_URL: "https://github.com/test/repo",
};

describe("config", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("loadConfig with all defaults - verifies all defaults are correct", () => {
    withEnv(REQUIRED_ENV, () => {
      const config = loadConfig();

      // Verify defaults
      assert.strictEqual(config.maxWorkers, 4);
      assert.strictEqual(config.workerTimeout, 1800);
      assert.strictEqual(config.mergeStrategy, "fast-forward");
      assert.strictEqual(config.llm.model, "glm-5");
      assert.strictEqual(config.llm.maxTokens, 8192);
      assert.strictEqual(config.llm.temperature, 0.7);
      assert.strictEqual(config.git.mainBranch, "main");
      assert.strictEqual(config.git.branchPrefix, "worker/");
      assert.strictEqual(config.sandbox.imageTag, "latest");
      assert.strictEqual(config.sandbox.cpuCores, 4);
      assert.strictEqual(config.sandbox.memoryMb, 8192);
      assert.strictEqual(config.sandbox.idleTimeout, 300);
      assert.strictEqual(config.targetRepoPath, "./target-repo");
      assert.strictEqual(config.pythonPath, "python3");
      assert.strictEqual(config.healthCheckInterval, 10);
    });
  });

  it("loadConfig with custom values - verifies each is read correctly", () => {
    const customEnv = {
      ...REQUIRED_ENV,
      MAX_WORKERS: "8",
      WORKER_TIMEOUT: "3600",
      MERGE_STRATEGY: "rebase",
      LLM_MODEL: "custom-model",
      LLM_MAX_TOKENS: "16384",
      LLM_TEMPERATURE: "0.5",
      GIT_MAIN_BRANCH: "master",
      GIT_BRANCH_PREFIX: "feature/",
      SANDBOX_IMAGE_TAG: "v1.0.0",
      SANDBOX_CPU_CORES: "8",
      SANDBOX_MEMORY_MB: "16384",
      SANDBOX_IDLE_TIMEOUT: "600",
      TARGET_REPO_PATH: "/custom/path",
      PYTHON_PATH: "/usr/bin/python",
      HEALTH_CHECK_INTERVAL: "30",
    };

    withEnv(customEnv, () => {
      const config = loadConfig();

      assert.strictEqual(config.maxWorkers, 8);
      assert.strictEqual(config.workerTimeout, 3600);
      assert.strictEqual(config.mergeStrategy, "rebase");
      assert.strictEqual(config.llm.model, "custom-model");
      assert.strictEqual(config.llm.maxTokens, 16384);
      assert.strictEqual(config.llm.temperature, 0.5);
      assert.strictEqual(config.git.mainBranch, "master");
      assert.strictEqual(config.git.branchPrefix, "feature/");
      assert.strictEqual(config.sandbox.imageTag, "v1.0.0");
      assert.strictEqual(config.sandbox.cpuCores, 8);
      assert.strictEqual(config.sandbox.memoryMb, 16384);
      assert.strictEqual(config.sandbox.idleTimeout, 600);
      assert.strictEqual(config.targetRepoPath, "/custom/path");
      assert.strictEqual(config.pythonPath, "/usr/bin/python");
      assert.strictEqual(config.healthCheckInterval, 30);
    });
  });

  it("throws on missing RUNPOD_ENDPOINT_ID", () => {
    withEnv({ RUNPOD_API_KEY: REQUIRED_ENV.RUNPOD_API_KEY, GIT_REPO_URL: REQUIRED_ENV.GIT_REPO_URL }, () => {
      delete process.env.RUNPOD_ENDPOINT_ID;
      assert.throws(
        () => loadConfig(),
        (err: Error) => err.message === "Missing required env: RUNPOD_ENDPOINT_ID"
      );
    });
  });

  it("throws on missing RUNPOD_API_KEY", () => {
    withEnv({ RUNPOD_ENDPOINT_ID: REQUIRED_ENV.RUNPOD_ENDPOINT_ID, GIT_REPO_URL: REQUIRED_ENV.GIT_REPO_URL }, () => {
      delete process.env.RUNPOD_API_KEY;
      assert.throws(
        () => loadConfig(),
        (err: Error) => err.message === "Missing required env: RUNPOD_API_KEY"
      );
    });
  });

  it("throws on missing GIT_REPO_URL", () => {
    withEnv({ RUNPOD_ENDPOINT_ID: REQUIRED_ENV.RUNPOD_ENDPOINT_ID, RUNPOD_API_KEY: REQUIRED_ENV.RUNPOD_API_KEY }, () => {
      delete process.env.GIT_REPO_URL;
      assert.throws(
        () => loadConfig(),
        (err: Error) => err.message === "Missing required env: GIT_REPO_URL"
      );
    });
  });

  it("constructs RunPod endpoint URL correctly", () => {
    withEnv(REQUIRED_ENV, () => {
      const config = loadConfig();
      assert.strictEqual(config.llm.endpoint, "https://api.runpod.ai/v2/test-endpoint-id/openai");
      assert.strictEqual(config.llm.apiKey, "test-api-key");
    });
  });

  it("throws on invalid merge strategy", () => {
    withEnv({ ...REQUIRED_ENV, MERGE_STRATEGY: "invalid" }, () => {
      assert.throws(
        () => loadConfig(),
        (err: Error) => err.message.includes("Invalid mergeStrategy")
      );
    });
  });

  it("accepts all valid merge strategies - fast-forward", () => {
    withEnv({ ...REQUIRED_ENV, MERGE_STRATEGY: "fast-forward" }, () => {
      const config = loadConfig();
      assert.strictEqual(config.mergeStrategy, "fast-forward");
    });
  });

  it("accepts all valid merge strategies - rebase", () => {
    withEnv({ ...REQUIRED_ENV, MERGE_STRATEGY: "rebase" }, () => {
      const config = loadConfig();
      assert.strictEqual(config.mergeStrategy, "rebase");
    });
  });

  it("accepts all valid merge strategies - merge-commit", () => {
    withEnv({ ...REQUIRED_ENV, MERGE_STRATEGY: "merge-commit" }, () => {
      const config = loadConfig();
      assert.strictEqual(config.mergeStrategy, "merge-commit");
    });
  });

  it("numeric values are parsed correctly", () => {
    withEnv({ ...REQUIRED_ENV, MAX_WORKERS: "8" }, () => {
      const config = loadConfig();
      assert.strictEqual(typeof config.maxWorkers, "number");
      assert.strictEqual(config.maxWorkers, 8);
    });
  });

  it("getConfig returns cached value", () => {
    withEnv(REQUIRED_ENV, () => {
      const config1 = getConfig();
      const config2 = getConfig();
      assert.strictEqual(config1, config2);
    });
  });
});
