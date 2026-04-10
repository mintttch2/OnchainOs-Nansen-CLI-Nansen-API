import chalk from 'chalk';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export const logger = {
  debug(msg: string, ...args: unknown[]): void {
    if (currentLevel <= LogLevel.DEBUG) {
      console.log(chalk.gray(`[DEBUG] ${msg}`), ...args);
    }
  },
  info(msg: string, ...args: unknown[]): void {
    if (currentLevel <= LogLevel.INFO) {
      console.log(chalk.blue(`[INFO] ${msg}`), ...args);
    }
  },
  success(msg: string, ...args: unknown[]): void {
    if (currentLevel <= LogLevel.INFO) {
      console.log(chalk.green(`[OK] ${msg}`), ...args);
    }
  },
  warn(msg: string, ...args: unknown[]): void {
    if (currentLevel <= LogLevel.WARN) {
      console.log(chalk.yellow(`[WARN] ${msg}`), ...args);
    }
  },
  error(msg: string, ...args: unknown[]): void {
    if (currentLevel <= LogLevel.ERROR) {
      console.log(chalk.red(`[ERROR] ${msg}`), ...args);
    }
  },
  signal(msg: string, ...args: unknown[]): void {
    console.log(chalk.magenta.bold(`[SIGNAL] ${msg}`), ...args);
  },
  trade(msg: string, ...args: unknown[]): void {
    console.log(chalk.cyan.bold(`[TRADE] ${msg}`), ...args);
  },
};
