import pc from "picocolors";

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

export const log = {
  info(msg: string): void {
    console.log(`${pc.dim(ts())} ${msg}`);
  },
  chat(player: string, text: string): void {
    console.log(`${pc.dim(ts())} ${pc.cyan(`<${player}>`)} ${text}`);
  },
  ai(text: string): void {
    console.log(`${pc.dim(ts())} ${pc.green("[AI]")} ${text}`);
  },
  tool(name: string, detail: string): void {
    console.log(`${pc.dim(ts())} ${pc.yellow(`⚙ ${name}`)} ${pc.dim(detail)}`);
  },
  warn(msg: string): void {
    console.warn(`${pc.dim(ts())} ${pc.yellow("warn")} ${msg}`);
  },
  error(msg: string): void {
    console.error(`${pc.dim(ts())} ${pc.red("error")} ${msg}`);
  },
};
