import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

export class TestUtils {
  /**
   * Wait for a condition to be true
   */
  static async waitFor(
    condition: () => Promise<boolean> | boolean,
    timeout = 30000,
    interval = 500,
  ): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (await condition()) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error(`Timeout waiting for condition after ${timeout}ms`);
  }

  /**
   * Wait for a port to be open
   */
  static async waitForPort(port: number, timeout = 30000): Promise<void> {
    await this.waitFor(async () => {
      try {
        const response = await fetch(`http://localhost:${port}/api/health`, {
          signal: AbortSignal.timeout(1000),
        });
        return response.ok;
      } catch {
        return false;
      }
    }, timeout);
  }

  /**
   * Wait for a process to exit
   */
  static async waitForProcessExit(pid: number, timeout = 10000): Promise<void> {
    await this.waitFor(async () => {
      try {
        process.kill(pid, 0); // Check if process exists
        return false;
      } catch {
        return true; // Process doesn't exist
      }
    }, timeout);
  }

  /**
   * Check if a port is in use
   */
  static async isPortInUse(port: number): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`lsof -i :${port} -t`);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Kill process on port
   */
  static async killProcessOnPort(port: number): Promise<void> {
    try {
      await execAsync(`lsof -ti :${port} | xargs kill -9 2>/dev/null || true`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch {
      // Ignore errors
    }
  }

  /**
   * Read PID file
   */
  static async readPidFile(pidFile = '/tmp/lss-orchestrator.pid'): Promise<number | null> {
    try {
      const content = await fs.readFile(pidFile, 'utf-8');
      const pid = parseInt(content.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Check if process is running
   */
  static async isProcessRunning(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute CLI command
   */
  static async execCli(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      exec(`npx lss ${command}`, (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: error?.code || 0,
        });
      });
    });
  }

  /**
   * Create a temporary CloudFormation template
   */
  static async createTempCfnTemplate(serviceName: string): Promise<string> {
    const template = {
      Resources: {
        TestTable: {
          Type: 'AWS::DynamoDB::Table',
          Properties: {
            TableName: `${serviceName}.TestTable`,
            KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
            BillingMode: 'PAY_PER_REQUEST',
          },
        },
        TestQueue: {
          Type: 'AWS::SQS::Queue',
          Properties: {
            QueueName: `${serviceName}-test-queue`,
          },
        },
        TestLambda: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            FunctionName: `${serviceName}-test-handler`,
            Handler: 'index.handler',
            Runtime: 'nodejs20.x',
          },
        },
        TestEventSource: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            FunctionName: { Ref: 'TestLambda' },
            EventSourceArn: { 'Fn::GetAtt': ['TestQueue', 'Arn'] },
            BatchSize: 1,
          },
        },
      },
    };

    const filePath = `/tmp/lss-test-${serviceName}-cfn.json`;
    await fs.writeFile(filePath, JSON.stringify(template, null, 2));
    return filePath;
  }

  /**
   * Create a temporary service directory with CloudFormation template
   * (for API that expects servicePath)
   */
  static async createTempServiceDir(serviceName: string, cfnTemplate?: any): Promise<string> {
    const servicePath = `/tmp/lss-test-service-${serviceName}-${Date.now()}`;
    const serverlessDir = `${servicePath}/.serverless`;

    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    await execAsync(`mkdir -p ${serverlessDir}`);

    const template = cfnTemplate || {
      Resources: {
        TestTable: {
          Type: 'AWS::DynamoDB::Table',
          Properties: {
            TableName: `${serviceName}.TestTable`,
            KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
            BillingMode: 'PAY_PER_REQUEST',
          },
        },
        TestQueue: {
          Type: 'AWS::SQS::Queue',
          Properties: {
            QueueName: `${serviceName}-test-queue`,
          },
        },
        TestTopic: {
          Type: 'AWS::SNS::Topic',
          Properties: {
            TopicName: `${serviceName}-test-topic`,
          },
        },
      },
    };

    await fs.writeFile(
      `${serverlessDir}/cloudformation-template-update-stack.json`,
      JSON.stringify(template, null, 2),
    );

    return servicePath;
  }

  /**
   * Cleanup temp files
   */
  static async cleanupTempFiles(): Promise<void> {
    try {
      await execAsync('rm -rf /tmp/lss-test-*.json /tmp/lss-test-service-*');
    } catch {
      // Ignore errors
    }
  }

  /**
   * Wait for LocalStack to be ready
   */
  static async waitForLocalStack(timeout = 30000): Promise<void> {
    await this.waitFor(async () => {
      try {
        const response = await fetch('http://localhost:4566/_localstack/health', {
          signal: AbortSignal.timeout(1000),
        });
        const data = await response.json();
        return data?.services?.dynamodb === 'running';
      } catch {
        return false;
      }
    }, timeout);
  }
}
