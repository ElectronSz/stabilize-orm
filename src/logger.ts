// src/logger.ts
import * as fs from "fs/promises";
import * as path from "path";
import {
  LogLevel,
  type LoggerConfig,
  type PoolMetrics,
  StabilizeError,
} from "./types";

export interface Logger {
  logQuery(query: string, params: any[], executionTime?: number): void;
  logError(error: Error): void;
  logMetrics(metrics: PoolMetrics): void;
  logInfo(message: string): void;
  logDebug(message: string): void;
}

export class ConsoleLogger implements Logger {
  private level: LogLevel;
  private filePath: string | null;
  private maxFileSize: number;
  private maxFiles: number;
  private currentFileSize: number = 0;

  constructor(config: LoggerConfig = {}) {
    this.level = config.level || LogLevel.INFO;
    this.filePath = config.filePath || null;
    this.maxFileSize = config.maxFileSize || 1 * 1024 * 1024; // 1MB
    this.maxFiles = config.maxFiles || 3;
  }

  private shouldLog(messageLevel: LogLevel): boolean {
    const levels = [
      LogLevel.ERROR,
      LogLevel.WARN,
      LogLevel.INFO,
      LogLevel.DEBUG,
    ];
    return levels.indexOf(messageLevel) <= levels.indexOf(this.level);
  }

  private async rotateLogFile() {
    if (!this.filePath) return;

    try {
      const stats = await fs.stat(this.filePath).catch(() => null);
      if (stats && stats.size >= this.maxFileSize) {
        for (let i = this.maxFiles - 1; i > 0; i--) {
          const oldPath = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`;
          const newPath = `${this.filePath}.${i}`;
          if (await fs.stat(oldPath).catch(() => null)) {
            await fs.rename(oldPath, newPath).catch(() => {});
          }
        }
        await fs.writeFile(this.filePath, "");
        this.currentFileSize = 0;
      }
    } catch (error) {
      console.error("Log rotation failed:", error);
    }
  }

  private async writeToFile(message: string) {
    if (!this.filePath) return;

    try {
      await this.rotateLogFile();
      const logEntry = `${new Date().toISOString()} ${message}\n`;
      await fs.appendFile(this.filePath, logEntry);
      this.currentFileSize += Buffer.byteLength(logEntry);
    } catch (error) {
      console.error("Failed to write to log file:", error);
    }
  }

  logQuery(query: string, params: any[], executionTime?: number) {
    if (this.shouldLog(LogLevel.DEBUG)) {
      const message = `[DEBUG] Query: ${query} | Params: ${JSON.stringify(params)} | Time: ${executionTime ? `${executionTime.toFixed(2)}ms` : "N/A"}`;
      console.log(message);
      if (this.filePath) {
        this.writeToFile(message);
      }
    }
  }

  logError(error: Error) {
    if (this.shouldLog(LogLevel.ERROR)) {
      const message = `[ERROR] ${error.message}${error.stack ? `\n${error.stack}` : ""}`;
      console.error(message);
      if (this.filePath) {
        this.writeToFile(message);
      }
    }
  }

  logMetrics(metrics: PoolMetrics) {
    if (this.shouldLog(LogLevel.INFO)) {
      const message = `[INFO] Pool Metrics: Active=${metrics.activeConnections}, Idle=${metrics.idleConnections}, Total=${metrics.totalConnections}`;
      console.log(message);
      if (this.filePath) {
        this.writeToFile(message);
      }
    }
  }

  logInfo(message: string) {
    if (this.shouldLog(LogLevel.INFO)) {
      const formatted = `[INFO] ${message}`;
      console.log(formatted);
      if (this.filePath) {
        this.writeToFile(formatted);
      }
    }
  }

  logDebug(message: string) {
    if (this.shouldLog(LogLevel.DEBUG)) {
      const formatted = `[DEBUG] ${message}`;
      console.log(formatted);
      if (this.filePath) {
        this.writeToFile(formatted);
      }
    }
  }
}
