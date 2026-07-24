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
  /**
   * Base URL of the GPU worker, normalised.
   *
   * People naturally paste the health-check URL they were testing with, so a
   * trailing `/healthz` (or any trailing slash) is stripped. Left in place it
   * turns every call into `/healthz/dispatch`, which 404s silently and looks
   * exactly like a worker that won't start.
   */
  private get workerUrl() {
    const raw = this.config.get<string>('livekit.workerUrl');
    if (!raw) return undefined;
    return raw
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/(healthz|health)$/i, '');
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
   * Everything the backend believes about the worker, for debugging.
   *
   * Config problems here are invisible from the outside — an unset or
   * misspelled variable makes dispatch a silent no-op, which is
   * indistinguishable from a worker that won't start. This reports what the
   * process actually resolved, so the two can be told apart in one request.
   */
  async diagnostics() {
    const configuredUrl = this.workerUrl;
    const result: Record<string, unknown> = {
      workerUrlConfigured: Boolean(configuredUrl),
      workerUrl: configuredUrl ?? null,
      rawEnvPresent: Boolean(process.env.LIVECAM_WORKER_URL),
      runpodManaged: this.isManaged(),
      state: this.state,
    };

    if (!configuredUrl) {
      result.problem =
        'LIVECAM_WORKER_URL is not set on this service. Dispatch is a no-op.';
      return result;
    }

    try {
      const started = Date.now();
      const res = await fetch(`${configuredUrl}/healthz`);
      const body: any = await res.json().catch(() => null);
      result.reachable = res.ok;
      result.latencyMs = Date.now() - started;
      result.workerHealth = body;
      if (!res.ok) {
        result.problem = `Worker returned ${res.status} from ${configuredUrl}/healthz`;
      } else if (body?.gpu === false) {
        result.problem = 'Worker is running on CPU, not GPU.';
      }
    } catch (e) {
      result.reachable = false;
      result.problem = `Cannot reach worker: ${(e as Error).message}`;
    }

    return result;
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

    // The start call is advisory. It fails for reasons that don't matter to
    // us — the pod is already running, Runpod hiccuped, the key lacks the
    // scope — so its result never decides the outcome. Only whether the
    // worker answers does. We log the body because a bare status code says
    // nothing about which of those it was.
    try {
      const res = await fetch(
        `https://rest.runpod.io/v1/pods/${this.podId}/start`,
        { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` } },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(
          `Pod start returned ${res.status}: ${body.slice(0, 300) || '(no body)'} ` +
            '— continuing to poll in case it is already up.',
        );
      }
    } catch (e) {
      this.logger.warn(`Pod start request failed: ${(e as Error).message}`);
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

    this.logger.error(
      `GPU worker did not answer at ${this.workerUrl}/healthz within ` +
        `${Math.round(this.bootTimeoutMs / 1000)}s. Check the pod is running ` +
        'and LIVECAM_WORKER_URL is correct.',
    );
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

  private pingFailureLogged = false;

  private async ping(): Promise<boolean> {
    if (!this.workerUrl) {
      if (!this.pingFailureLogged) {
        this.pingFailureLogged = true;
        this.logger.error('LIVECAM_WORKER_URL is not set — cannot reach the GPU worker');
      }
      return false;
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`${this.workerUrl}/healthz`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return false;

      const body: any = await res.json();
      // Warn once if the worker is up but running on CPU — it will "work"
      // at a couple of frames per second, which is not usable live.
      if (body?.engine === true && body?.gpu === false && !this.pingFailureLogged) {
        this.pingFailureLogged = true;
        this.logger.warn(
          'Worker is healthy but running on CPU, not GPU. Face swap will be ' +
            'unusably slow. Rebuild the worker image.',
        );
      }
      return body?.engine === true;
    } catch (e) {
      if (!this.pingFailureLogged) {
        this.pingFailureLogged = true;
        this.logger.warn(
          `Worker unreachable at ${this.workerUrl}/healthz: ${(e as Error).message}`,
        );
      }
      return false;
    }
  }
}
