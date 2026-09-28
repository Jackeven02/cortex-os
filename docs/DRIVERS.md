# Drivers

Cortex talks to models and tools through drivers. This page documents the
built-in **LLM drivers**, how they are selected, and the environment variables
each one reads. Tool and memory drivers are covered in
[HACKING.md](./HACKING.md) (how to write your own) and
[ARCHITECTURE.md](./ARCHITECTURE.md) (how the registry works).

## Selection order

`cortex spawn` (and every command that boots a kernel) picks a default LLM
driver from the environment, in this order:

| Priority | Condition | Driver |
|----------|-----------|--------|
| 1 | `DEEPSEEK_API_KEY` set | `deepseek` |
| 2 | `OPENAI_API_KEY` set | `openai` |
| 3 | none of the above | `mock` (deterministic, offline) |

`--driver <name>` overrides the selection for one invocation. Naming a driver
that is not built in prints a warning and falls back to `mock`.

## `mock`

The deterministic offline driver. Always registered, never calls the network.
Reply is derived from the prompt text, so tests and demos are reproducible.
This is what CI and the smoke suite run against.

## `deepseek`

Native DeepSeek chat driver.

```sh
export DEEPSEEK_API_KEY="..."
cortex spawn --role assistant --task "Summarize this file" --driver deepseek
```

| Env var | Meaning |
|---------|---------|
| `DEEPSEEK_API_KEY` | API key; presence also auto-selects the driver |
| `DEEPSEEK_BASE_URL` | Override the endpoint (any OpenAI-compatible proxy) |
| `DEEPSEEK_MODEL` | Default model when the request omits one |

## `openai` — and any OpenAI-compatible endpoint

The OpenAI driver speaks the standard `/v1/chat/completions` protocol, so it
also works against OpenRouter, vLLM, LiteLLM, or any compatible proxy —
without bypassing the CLI:

```sh
export OPENAI_API_KEY="sk-or-..."
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
export OPENAI_MODEL="meta-llama/llama-3.1-8b-instruct:free"
cortex spawn --role assistant --task "Hello"
```

| Env var | Meaning |
|---------|---------|
| `OPENAI_API_KEY` | API key; presence also auto-selects the driver |
| `OPENAI_BASE_URL` | Override the endpoint (OpenRouter / vLLM / proxy) |
| `OPENAI_MODEL` | Default model when the request omits one |

USD cost is computed from hard-coded pricing for known OpenAI models; custom
endpoints can supply `pricing` when constructing the driver programmatically.
