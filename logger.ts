/**
 * @file logger.ts
 * @description Provides a flexible logger that can write to the console and/or rotating log files.
 * @author ElectronSz
 */

import * as fs from "fs/promises";
import {
  LogLevel,
  type LoggerConfig,
  type PoolMetrics,
  StabilizeError,
} from "./types";

/**
 * Defines the interface for a logger that can be used within the ORM.
 */
export interface Logger {
  logQuery(query: string, params: any[], executionTime?: number): void;
  logError(error: Error): void;
  logMetrics(metrics: PoolMetrics): void;
  logInfo(message: string): void;
  logWarn(message: string): void;
  logDebug(message: string): void;
}

/**
 * A logger implementation that writes to the console and can optionally write to rotating files.
 */
export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;
  private readonly filePath: string | null;
  private readonly maxFileSize: number;
  private readonly maxFiles: number;

  constructor(config: LoggerConfig = {}) {
    this.level = config.level ?? LogLevel.Info;
    this.filePath = config.filePath || null;
    this.maxFileSize = config.maxFileSize || 1 * 1024 * 1024; // 1MB
    this.maxFiles = config.maxFiles || 3;
  }

  /** @internal Checks if a message at a given level should be logged. */
  private shouldLog(messageLevel: LogLevel): boolean {
    return messageLevel <= this.level;
  }

  /** @internal Rotates log files if the current one exceeds the max size. */
  private async rotateLogFile(): Promise<void> {
    if (!this.filePath) return;

    try {
      const stats = await fs.stat(this.filePath).catch(() => null);
      if (!stats || stats.size < this.maxFileSize) {
        return; // No rotation needed
      }

      const oldestLog = `${this.filePath}.${this.maxFiles}`;
      await fs.unlink(oldestLog).catch(() => {});

      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const source = `${this.filePath}.${i}`;
        const destination = `${this.filePath}.${i + 1}`;
        if (await fs.stat(source).catch(() => null)) {
          await fs.rename(source, destination);
        }
      }
      await fs.rename(this.filePath, `${this.filePath}.1`);
    } catch (error) {
      // Use StabilizeError for internal logger failures
      const logError = new StabilizeError("Log rotation failed", "LOG_ROTATION_ERROR", error as Error);
      console.error(`[LOGGER_ERROR] ${logError.message}\n${logError.stack}`);
    }
  }

  /** @internal Writes a formatted message to the console and/or a file. */
  private async log(level: LogLevel, message: string): Promise<void> {
    if (!this.shouldLog(level)) return;

    const levelStr = LogLevel[level].toUpperCase();
    const logEntry = `[${levelStr}] ${new Date().toISOString()} - ${message}`;

    switch (level) {
      case LogLevel.Error: console.error(logEntry); break;
      case LogLevel.Warn: console.warn(logEntry); break;
      default: console.log(logEntry); break;
    }

    if (this.filePath) {
      try {
        await this.rotateLogFile();
        await fs.appendFile(this.filePath, logEntry + "\n");
      } catch (error) {
        // Use StabilizeError for internal logger failures
        const logError = new StabilizeError("Failed to write to log file", "LOG_WRITE_ERROR", error as Error);
        console.error(`[LOGGER_ERROR] ${logError.message}\n${logError.stack}`);
      }
    }
  }

  public logQuery(query: string, params: any[], executionTime?: number): void {
    const time = executionTime ? `${executionTime.toFixed(2)}ms` : "N/A";
    this.log(LogLevel.Debug, `Query: ${query} | Params: ${JSON.stringify(params)} | Time: ${time}`);
  }

  public logError(error: Error): void {
    const message = `${error.message}${error.stack ? `\n${error.stack}` : ""}`;
    this.log(LogLevel.Error, message);
  }

  public logMetrics(metrics: PoolMetrics): void {
    const message = `Pool Metrics: Active=${metrics.activeConnections}, Idle=${metrics.idleConnections}, Total=${metrics.totalConnections}`;
    this.log(LogLevel.Info, message);
  }

  public logInfo(message: string): void {
    this.log(LogLevel.Info, message);
  }
  
  public logWarn(message: string): void {
    this.log(LogLevel.Warn, message);
  }

  public logDebug(message: string): void {
    this.log(LogLevel.Debug, message);
  }
}