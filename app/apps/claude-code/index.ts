import type { AppDefinition } from "../app-definition";
import { APP_ID, createClaudeCodeWindow } from "./claude-code-app";

const claudeCodeApp: AppDefinition = {
  appId: APP_ID,
  title: "Claude Code",
  icon: "terminal",
  launch: (ctx) => ctx.launchInProcessApp(APP_ID, `window:${APP_ID}`, createClaudeCodeWindow),
};
export default claudeCodeApp;
