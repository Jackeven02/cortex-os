# 代码库体检报告

- 扫描文件数：**50**
- 生成时间：2026-09-24T12:19:20.704Z

## 1. TODO / FIXME / HACK / XXX

共 **14** 处。

| 文件 | 数量 |
| --- | --- |
| projects\codebase-audit\audit.ts | 12 |
| src\kernel\recorder.ts | 2 |

## 2. 最长的文件

总行数 **28059**。

| 文件 | 行数 |
| --- | --- |
| scripts\smoke.ts | 10294 |
| src\kernel\boot.ts | 1150 |
| src\kernel\process_table.ts | 1139 |
| src\kernel\ipc.ts | 1077 |
| src\kernel\memory.ts | 927 |
| src\drivers\tool\mcp.ts | 880 |
| src\kernel\init.ts | 843 |
| src\kernel\driver_registry.ts | 769 |

## 3. 代码卫生

- `console.log`：211 处
- `any` 类型：4 处

| 文件 | any 数量 |
| --- | --- |
| scripts\smoke.ts | 2 |
| examples\capabilities-agent.ts | 1 |
| src\cli\commands\spawn.ts | 1 |

---

_由 cortex 体检小队生成：三个 worker 进程并行扫描，监督者汇总。_