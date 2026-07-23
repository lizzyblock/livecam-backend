import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type WorkerState = 'ASLEEP' | 'WAKING' | 'AWAKE' | 'UNMANAGED';

/**
 * Keeps the GPU worker asleep when nobody is streaming.
 *
 * Billing model: a stopped Runpod Pod bills only for its disk, not the GPU.
 * So the pod is stopped whenever LiveCam is idle and started on demand.
 *
 * Cold start is the tradeoff — the pod needs ~20-60s to boot and load the
 * face models. We hide that behind `prewarm()`, which the frontend calls the
 * moment a user opens the LiveCam page. By the time they've picked a face and
 * pressed "Go live", the worker is usually already up.
 *
 * If RUNPOD_API_KEY / RUNPOD_POD_ID aren't set, this becomes a no-op and the
 * worker is assumed to be always-on (self-hosted, LiveKit Cloud, etc).
 */
@Injectable()
export class WorkerControlService {
  private readonly logger = new Logger(WorkerControlService.name);
  private state: WorkerState = 'ASLEEP';
  private wakePromise: Promise<boolean> | null = null;

  constructor(private readonly config: ConfigService) {
    if (!this.podId || !this.apiKey) {
      this.state = 'UNMANAGED';
      this.logger.log('Worker autoscaling disabled — assuming always-on worker');
    }
  }

  private get podId() {
    return this.config.get<string>('worker.runpodPodId');
  }
  private get apiKey() {
    return this.config.get<string>('worker.runpodApiKey');
  }
  private get workerUrl() {
    return this.config.get<string>('livekit.workerUrl');
  }
  private get bootTimeoutMs() {
    return this.config.get<number>('worker.bootTimeoutMs') ?? 120_000;
  }

  isManaged() {
    return this.state !== 'UNMANAGED';
  }

  /** Current status, for the dashboard to show a "warming up" indicator. */
  async status() {
    if (!this.isManaged()) return { state: 'AWAKE' as const, managed: false };
    const healthy = await this.ping();
    if (healthy) this.state = 'AWAKE';
    return { state: this.state, managed: true };
  }

  /**
   * Called when a user opens the LiveCam page — starts the pod early so the
   * boot happens while they're choosing a face rather than after they click.
   */
  async prewarm(): Promise<void> {
    if (!this.isManaged()) return;
    void this.ensureAwake().catch((e) =>
      this.logger.warn(`Prewarm failed: ${e.message}`),
    );
  }

  /**
   * Guarantees the worker is reachable before a session starts.
   * Concurrent callers share a single wake attempt.
   */
  async ensureAwake(): Promise<boolean> {
    if (!this.isManaged()) return true;
    if (await this.ping()) {
      this.state = 'AWAKE';
      return true;
    }
    if (this.wakePromise) return this.wakePromise;

    this.wakePromise = this.wake().finally(() => {
      this.wakePromise = null;
    });
    return this.wakePromise;
  }

  private async wake(): Promise<boolean> {
    this.state = 'WAKING';
    this.logger.log(`Starting GPU pod ${this.podId} …`);

    const res = await fetch(`https://rest.runpod.io/v1/pods/${this.podId}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    // 4xx here often just means "already running" — keep polling regardless.
    if (!res.ok && res.status >= 500) {
      this.logger.error(`Pod start failed: ${res.status}`);
      this.state = 'ASLEEP';
      return false;
    }

    const deadline = Date.now() + this.bootTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      if (await this.ping()) {
        this.state = 'AWAKE';
        this.logger.log('GPU worker is awake');
        return true;
      }
    }

    this.logger.error('GPU worker did not come up before timeout');
    this.state = 'ASLEEP';
    return false;
  }

  /** Put the pod back to sleep — called when the last session ends. */
  async sleep(): Promise<void> {
    if (!this.isManaged()) return;
    this.logger.log(`Stopping GPU pod ${this.podId} — no active sessions`);
    await fetch(`https://rest.runpod.io/v1/pods/${this.podId}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
    }).catch((e) => this.logger.warn(`Pod stop failed: ${e.message}`));
    this.state = 'ASLEEP';
  }

  private async ping(): Promise<boolean> {
    if (!this.workerUrl) return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`${this.workerUrl}/healthz`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return false;
      const body: any = await res.json();
      return body?.engine === true;
    } catch {
      return false;
    }
  }
}
