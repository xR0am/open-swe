import {
  ConfigurableModel,
  initChatModel,
} from "langchain/chat_models/universal";
import { GraphConfig } from "@open-swe/shared/open-swe/types";
import { createLogger, LogLevel } from "../logger.js";
import {
  LLMTask,
  TASK_TO_CONFIG_DEFAULTS_MAP,
} from "@open-swe/shared/open-swe/llm-task";
import { isAllowedUser } from "@open-swe/shared/github/allowed-users";
import { decryptSecret } from "@open-swe/shared/crypto";
import { API_KEY_REQUIRED_MESSAGE } from "@open-swe/shared/constants";

const logger = createLogger(LogLevel.INFO, "ModelManager");

type InitChatModelArgs = Parameters<typeof initChatModel>[1];

export interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
  openedAt?: number;
}

interface ModelLoadConfig {
  provider: Provider;
  modelName: string;
  temperature?: number;
  maxTokens?: number;
  thinkingModel?: boolean;
  thinkingBudgetTokens?: number;
}

export enum CircuitState {
  /*
   * CLOSED: Normal operation
   */
  CLOSED = "CLOSED",
  /*
   * OPEN: Failing, use fallback
   */
  OPEN = "OPEN",
}

export const PROVIDER_FALLBACK_ORDER = [
  "openai",
  "anthropic",
  "google-genai",
  "openrouter",
  "moonshot-ai",
  "deepseek",
  "qwen",
  "z-ai",
] as const;
export type Provider = (typeof PROVIDER_FALLBACK_ORDER)[number];

export interface ModelManagerConfig {
  /*
   * Failures before opening circuit
   */
  circuitBreakerFailureThreshold: number;
  /*
   * Time to wait before trying again (ms)
   */
  circuitBreakerTimeoutMs: number;
  fallbackOrder: Provider[];
}

export const DEFAULT_MODEL_MANAGER_CONFIG: ModelManagerConfig = {
  circuitBreakerFailureThreshold: 2, // TBD, need to test
  circuitBreakerTimeoutMs: 180000, // 3 minutes timeout
  fallbackOrder: [...PROVIDER_FALLBACK_ORDER],
};

const MAX_RETRIES = 3;
const THINKING_BUDGET_TOKENS = 5000;

// Helper function to get base URL for OpenAI-compatible providers
const getProviderBaseUrl = (provider: Provider, graphConfig?: GraphConfig): string | undefined => {
  switch (provider) {
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "moonshot-ai":
      return "https://api.moonshot.cn/v1";
    case "qwen":
      // Use international endpoint if configured, otherwise use China region
      const useInternational = process.env.QWEN_USE_INTERNATIONAL === "true" || 
                              graphConfig?.configurable?.qwenUseInternational;
      return useInternational 
        ? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" 
        : "https://dashscope.aliyuncs.com/compatible-mode/v1";
    case "z-ai":
      return "https://api.z.ai/api/paas/v4/";
    default:
      return undefined;
  }
};

// Helper function to get the actual provider to use with LangChain
const getLangChainProvider = (provider: Provider): "openai" | "deepseek" | Provider => {
  switch (provider) {
    case "deepseek":
      return "deepseek"; // Use dedicated DeepSeek package
    case "moonshot-ai":
    case "qwen":
    case "z-ai":
      return "openai"; // These providers use OpenAI-compatible APIs
    default:
      return provider;
  }
};

const providerToApiKey = (
  providerName: string,
  apiKeys: Record<string, string | string[]>,
): string => {
  switch (providerName) {
    case "openai":
      return apiKeys.openaiApiKey as string;
    case "anthropic":
      return apiKeys.anthropicApiKey as string;
    case "google-genai":
      return apiKeys.googleApiKey as string;
    case "moonshot-ai":
      return apiKeys.moonshotApiKey as string;
    case "deepseek":
      return apiKeys.deepseekApiKey as string;
    case "qwen":
      return apiKeys.qwenApiKey as string;
    case "z-ai":
      return apiKeys.zaiApiKey as string;
    case "openrouter":
      const openRouterKeys = apiKeys.openrouter as string[];
      if (!openRouterKeys || openRouterKeys.length === 0) {
        throw new Error("No OpenRouter API keys provided.");
      }
      return openRouterKeys[0];
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
};

export class ModelManager {
  private config: ModelManagerConfig;
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();
  // WeakMap to track original providers for model instances to prevent provider confusion
  private originalProviders: WeakMap<ConfigurableModel, Provider> = new WeakMap();

  /**
   * Infer the original provider from baseUrl during deserialization
   */
  private inferProviderFromBaseUrl(baseUrl?: string): Provider | null {
    if (!baseUrl) return null;
    
    if (baseUrl.includes("api.deepseek.com")) return "deepseek";
    if (baseUrl.includes("api.moonshot.cn")) return "moonshot-ai";
    if (baseUrl.includes("dashscope.aliyuncs.com")) return "qwen";
    
    return null;
  }

  /**
   * Get the original provider for a model instance, with fallback to inference from baseUrl
   */
  private getOriginalProvider(model: ConfigurableModel): Provider | null {
    // First try to get from WeakMap
    const storedProvider = this.originalProviders.get(model);
    if (storedProvider) return storedProvider;
    
    // Fallback: infer from baseUrl if available in model configuration
    const baseUrl = model._defaultConfig?.baseUrl;
    return this.inferProviderFromBaseUrl(baseUrl);
  }

  constructor(config: Partial<ModelManagerConfig> = {}) {
    this.config = { ...DEFAULT_MODEL_MANAGER_CONFIG, ...config };

    logger.info("Initialized", {
      config: this.config,
      fallbackOrder: this.config.fallbackOrder,
    });
  }

  /**
   * Load a single model (no fallback during loading)
   */
  async loadModel(graphConfig: GraphConfig, task: LLMTask) {
    const baseConfig = this.getBaseConfigForTask(graphConfig, task);
    const model = await this.initializeModel(baseConfig, graphConfig);
    return model;
  }

  private getUserApiKey(
    graphConfig: GraphConfig,
    provider: Provider,
  ): string | null {
    const userLogin = (graphConfig.configurable as any)?.langgraph_auth_user
      ?.display_name;
    const secretsEncryptionKey = process.env.SECRETS_ENCRYPTION_KEY;

    if (!secretsEncryptionKey) {
      throw new Error(
        "SECRETS_ENCRYPTION_KEY environment variable is required",
      );
    }
    if (!userLogin) {
      throw new Error("User login not found in config");
    }

    // If the user is allowed, we can return early
    if (isAllowedUser(userLogin)) {
      return null;
    }

    const apiKeys = graphConfig.configurable?.apiKeys;
    if (!apiKeys) {
      throw new Error(API_KEY_REQUIRED_MESSAGE);
    }

    const missingProviderKeyMessage = `No API key found for provider: ${provider}. Please add one in the settings page.`;

    const providerApiKey = providerToApiKey(provider, apiKeys);
    if (!providerApiKey) {
      throw new Error(missingProviderKeyMessage);
    }

    const apiKey = decryptSecret(providerApiKey, secretsEncryptionKey);
    if (!apiKey) {
      throw new Error(missingProviderKeyMessage);
    }

    return apiKey;
  }

  /**
   * Initialize the model instance
   */
  public async initializeModel(
    config: ModelLoadConfig,
    graphConfig: GraphConfig,
  ) {
    const {
      provider,
      modelName,
      temperature,
      maxTokens,
      thinkingModel,
      thinkingBudgetTokens,
    } = config;

    const thinkingMaxTokens = thinkingBudgetTokens
      ? thinkingBudgetTokens * 4
      : undefined;

    let finalMaxTokens = maxTokens ?? 10_000;
    if (modelName.includes("claude-3-5-haiku")) {
      finalMaxTokens = finalMaxTokens > 8_192 ? 8_192 : finalMaxTokens;
    }

    if (provider === "openrouter") {
      const { ChatOpenRouter } = await import("./chat-openrouter.js");
      return new ChatOpenRouter({
        modelName,
        temperature: temperature ?? 0,
        maxTokens: finalMaxTokens,
        graphConfig,
        task: (graphConfig.configurable as any).task,
      });
    }

    const apiKey = this.getUserApiKey(graphConfig, provider);
    const langchainProvider = getLangChainProvider(provider);
    const baseUrl = getProviderBaseUrl(provider, graphConfig);

    const modelOptions: InitChatModelArgs = {
      modelProvider: langchainProvider,
      max_retries: MAX_RETRIES,
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl && (langchainProvider === "openai" || langchainProvider === "deepseek") ? { baseUrl } : {}),
      ...(thinkingModel && provider === "anthropic"
        ? {
            thinking: { budget_tokens: thinkingBudgetTokens, type: "enabled" },
            maxTokens: thinkingMaxTokens,
          }
        : modelName.includes("gpt-5")
          ? {
              max_completion_tokens: finalMaxTokens,
              temperature: 1,
            }
          : {
              maxTokens: finalMaxTokens,
              temperature: thinkingModel ? undefined : temperature,
            }),
    };

    logger.info("Initializing model", {
      originalProvider: provider,
      langchainProvider,
      modelName,
      baseUrl,
    });

    const model = await initChatModel(modelName, modelOptions);
    
    // Store the original provider for this model instance to prevent confusion on re-initialization
    this.originalProviders.set(model, provider);
    
    return model;
  }

  public getModelConfigs(
    config: GraphConfig,
    task: LLMTask,
    selectedModel: ConfigurableModel,
  ) {
    const configs: ModelLoadConfig[] = [];
    const baseConfig = this.getBaseConfigForTask(config, task);

    const defaultConfig = selectedModel._defaultConfig;
    let selectedModelConfig: ModelLoadConfig | null = null;

    if (defaultConfig) {
      // Use original provider instead of the potentially mapped "openai" provider
      const originalProvider = this.getOriginalProvider(selectedModel);
      const provider = originalProvider || (defaultConfig.modelProvider as Provider);
      const modelName = defaultConfig.model;

      if (provider && modelName) {
        const isThinkingModel = baseConfig.thinkingModel;
        selectedModelConfig = {
          provider,
          modelName,
          ...(modelName.includes("gpt-5")
            ? {
                max_completion_tokens:
                  defaultConfig.maxTokens ?? baseConfig.maxTokens,
                temperature: 1,
              }
            : {
                maxTokens: defaultConfig.maxTokens ?? baseConfig.maxTokens,
                temperature:
                  defaultConfig.temperature ?? baseConfig.temperature,
              }),
          ...(isThinkingModel
            ? {
                thinkingModel: true,
                thinkingBudgetTokens: THINKING_BUDGET_TOKENS,
              }
            : {}),
        };
        configs.push(selectedModelConfig);
      }
    }

    // Add fallback models
    for (const provider of this.config.fallbackOrder) {
      const fallbackModel = this.getDefaultModelForProvider(provider, task);
      if (
        fallbackModel &&
        (!selectedModelConfig ||
          fallbackModel.modelName !== selectedModelConfig.modelName)
      ) {
        // Check if fallback model is a thinking model
        const isThinkingModel =
          (provider === "openai" && fallbackModel.modelName.startsWith("o")) ||
          fallbackModel.modelName.includes("extended-thinking");

        const fallbackConfig = {
          ...fallbackModel,
          ...(fallbackModel.modelName.includes("gpt-5")
            ? {
                max_completion_tokens: baseConfig.maxTokens,
                temperature: 1,
              }
            : {
                maxTokens: baseConfig.maxTokens,
                temperature: isThinkingModel
                  ? undefined
                  : baseConfig.temperature,
              }),
          ...(isThinkingModel
            ? {
                thinkingModel: true,
                thinkingBudgetTokens: THINKING_BUDGET_TOKENS,
              }
            : {}),
        };
        configs.push(fallbackConfig);
      }
    }

    return configs;
  }

  /**
   * Get the model name for a task from GraphConfig
   */
  public getModelNameForTask(config: GraphConfig, task: LLMTask): string {
    const baseConfig = this.getBaseConfigForTask(config, task);
    return baseConfig.modelName;
  }

  /**
   * Get base configuration for a task from GraphConfig
   */
  private getBaseConfigForTask(
    config: GraphConfig,
    task: LLMTask,
  ): ModelLoadConfig {
    const taskMap = {
      [LLMTask.PLANNER]: {
        modelName:
          config.configurable?.[`${task}ModelName`] ??
          TASK_TO_CONFIG_DEFAULTS_MAP[task].modelName,
        temperature: config.configurable?.[`${task}Temperature`] ?? 0,
      },
      [LLMTask.PROGRAMMER]: {
        modelName:
          config.configurable?.[`${task}ModelName`] ??
          TASK_TO_CONFIG_DEFAULTS_MAP[task].modelName,
        temperature: config.configurable?.[`${task}Temperature`] ?? 0,
      },
      [LLMTask.REVIEWER]: {
        modelName:
          config.configurable?.[`${task}ModelName`] ??
          TASK_TO_CONFIG_DEFAULTS_MAP[task].modelName,
        temperature: config.configurable?.[`${task}Temperature`] ?? 0,
      },
      [LLMTask.ROUTER]: {
        modelName:
          config.configurable?.[`${task}ModelName`] ??
          TASK_TO_CONFIG_DEFAULTS_MAP[task].modelName,
        temperature: config.configurable?.[`${task}Temperature`] ?? 0,
      },
      [LLMTask.SUMMARIZER]: {
        modelName:
          config.configurable?.[`${task}ModelName`] ??
          TASK_TO_CONFIG_DEFAULTS_MAP[task].modelName,
        temperature: config.configurable?.[`${task}Temperature`] ?? 0,
      },
    };

    const taskConfig = taskMap[task];
    const modelStr = taskConfig.modelName;
    const [modelProvider, ...modelNameParts] = modelStr.split(":");

    let thinkingModel = false;
    if (modelNameParts[0] === "extended-thinking") {
      thinkingModel = true;
      modelNameParts.shift();
    }

    const modelName = modelNameParts.join(":");
    if (modelProvider === "openai" && modelName.startsWith("o")) {
      thinkingModel = true;
    }

    const thinkingBudgetTokens = THINKING_BUDGET_TOKENS;

    return {
      modelName,
      provider: modelProvider as Provider,
      ...(modelName.includes("gpt-5")
        ? {
            max_completion_tokens: config.configurable?.maxTokens ?? 10_000,
            temperature: 1,
          }
        : {
            maxTokens: config.configurable?.maxTokens ?? 10_000,
            temperature: taskConfig.temperature,
          }),
      thinkingModel,
      thinkingBudgetTokens,
    };
  }

  /**
   * Get default model for a provider and task
   */
  private getDefaultModelForProvider(
    provider: Provider,
    task: LLMTask,
  ): ModelLoadConfig | null {
    const defaultModels: Record<Provider, Record<LLMTask, string>> = {
      anthropic: {
        [LLMTask.PLANNER]: "claude-sonnet-4-0",
        [LLMTask.PROGRAMMER]: "claude-sonnet-4-0",
        [LLMTask.REVIEWER]: "claude-sonnet-4-0",
        [LLMTask.ROUTER]: "claude-3-5-haiku-latest",
        [LLMTask.SUMMARIZER]: "claude-sonnet-4-0",
      },
      "google-genai": {
        [LLMTask.PLANNER]: "gemini-2.5-flash",
        [LLMTask.PROGRAMMER]: "gemini-2.5-pro",
        [LLMTask.REVIEWER]: "gemini-2.5-flash",
        [LLMTask.ROUTER]: "gemini-2.5-flash",
        [LLMTask.SUMMARIZER]: "gemini-2.5-pro",
      },
      openai: {
        [LLMTask.PLANNER]: "gpt-5",
        [LLMTask.PROGRAMMER]: "gpt-5",
        [LLMTask.REVIEWER]: "gpt-5",
        [LLMTask.ROUTER]: "gpt-5-nano",
        [LLMTask.SUMMARIZER]: "gpt-5-mini",
      },
      "moonshot-ai": {
        [LLMTask.PLANNER]: "kimi-k2-0711-preview",
        [LLMTask.PROGRAMMER]: "kimi-k2-0711-preview",
        [LLMTask.REVIEWER]: "kimi-k2-0711-preview",
        [LLMTask.ROUTER]: "kimi-k2-0711-preview",
        [LLMTask.SUMMARIZER]: "kimi-k2-0711-preview",
      },
      deepseek: {
        [LLMTask.PLANNER]: "deepseek-reasoner",
        [LLMTask.PROGRAMMER]: "deepseek-chat",
        [LLMTask.REVIEWER]: "deepseek-chat",
        [LLMTask.ROUTER]: "deepseek-chat",
        [LLMTask.SUMMARIZER]: "deepseek-chat",
      },
      qwen: {
        [LLMTask.PLANNER]: "qwen-plus",
        [LLMTask.PROGRAMMER]: "qwen3-coder-plus",
        [LLMTask.REVIEWER]: "qwen-plus",
        [LLMTask.ROUTER]: "qwen-plus",
        [LLMTask.SUMMARIZER]: "qwen-plus",
      },
      "z-ai": {
 [LLMTask.PLANNER]: "",
 [LLMTask.PROGRAMMER]: "",
 [LLMTask.REVIEWER]: "",
 [LLMTask.ROUTER]: "",
 [LLMTask.SUMMARIZER]: "",
      },
      openrouter: {
        [LLMTask.PLANNER]: "openrouter/anthropic/claude-3-haiku",
        [LLMTask.PROGRAMMER]: "openrouter/anthropic/claude-3-haiku",
        [LLMTask.REVIEWER]: "openrouter/anthropic/claude-3-haiku",
        [LLMTask.ROUTER]: "openrouter/anthropic/claude-3-haiku",
        [LLMTask.SUMMARIZER]: "openrouter/anthropic/claude-3-haiku",
      },
      // These are already present, adding them here to fulfill the Record type
      // "moonshot-ai": {},
      // deepseek: {},
      // qwen: {},
 // "z-ai": {},
    };

    const modelName = defaultModels[provider][task];
    if (!modelName) {
      return null;
    }
    return { provider, modelName };
  }

  /**
   * Circuit breaker methods
   */
  public isCircuitClosed(modelKey: string): boolean {
    const state = this.getCircuitState(modelKey);

    if (state.state === CircuitState.CLOSED) {
      return true;
    }

    if (state.state === CircuitState.OPEN && state.openedAt) {
      const timeElapsed = Date.now() - state.openedAt;
      if (timeElapsed >= this.config.circuitBreakerTimeoutMs) {
        state.state = CircuitState.CLOSED;
        state.failureCount = 0;
        delete state.openedAt;

        logger.info(
          `${modelKey}: Circuit breaker automatically recovered: OPEN → CLOSED`,
          {
            timeElapsed: (timeElapsed / 1000).toFixed(1) + "s",
          },
        );
        return true;
      }
    }

    return false;
  }

  private getCircuitState(modelKey: string): CircuitBreakerState {
    if (!this.circuitBreakers.has(modelKey)) {
      this.circuitBreakers.set(modelKey, {
        state: CircuitState.CLOSED,
        failureCount: 0,
        lastFailureTime: 0,
      });
    }
    return this.circuitBreakers.get(modelKey)!;
  }

  public recordSuccess(modelKey: string): void {
    const circuitState = this.getCircuitState(modelKey);

    circuitState.state = CircuitState.CLOSED;
    circuitState.failureCount = 0;
    delete circuitState.openedAt;

    logger.debug(`${modelKey}: Circuit breaker reset after successful request`);
  }

  public recordFailure(modelKey: string): void {
    const circuitState = this.getCircuitState(modelKey);
    const now = Date.now();

    circuitState.lastFailureTime = now;
    circuitState.failureCount++;

    if (
      circuitState.failureCount >= this.config.circuitBreakerFailureThreshold
    ) {
      circuitState.state = CircuitState.OPEN;
      circuitState.openedAt = now;

      logger.warn(
        `${modelKey}: Circuit breaker opened after ${circuitState.failureCount} failures`,
        {
          timeoutMs: this.config.circuitBreakerTimeoutMs,
          willRetryAt: new Date(
            now + this.config.circuitBreakerTimeoutMs,
          ).toISOString(),
        },
      );
    }
  }

  /**
   * Monitoring and observability methods
   */
  public getCircuitBreakerStatus(): Map<string, CircuitBreakerState> {
    return new Map(this.circuitBreakers);
  }

  /**
   * Cleanup on shutdown
   */
  public shutdown(): void {
    this.circuitBreakers.clear();
    logger.info("Shutdown complete");
  }
}

let globalModelManager: ModelManager | null = null;

export function getModelManager(
  config?: Partial<ModelManagerConfig>,
): ModelManager {
  if (!globalModelManager) {
    globalModelManager = new ModelManager(config);
  }
  return globalModelManager;
}

export function resetModelManager(): void {
  if (globalModelManager) {
    globalModelManager.shutdown();
    globalModelManager = null;
  }
}
