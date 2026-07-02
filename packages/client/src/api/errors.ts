/**
 * Structured errors raised by the WeChat iLink API client.
 */

export interface WeChatApiErrorOptions {
  endpoint: string;
  message: string;
  status?: number;
  statusText?: string;
  ret?: number;
  errcode?: number;
  errmsg?: string;
  responseBody?: string;
  timedOut?: boolean;
  cause?: unknown;
}

export class WeChatApiError extends Error {
  readonly endpoint: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly ret?: number;
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly responseBody?: string;
  readonly timedOut: boolean;

  constructor(opts: WeChatApiErrorOptions) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "WeChatApiError";
    this.endpoint = opts.endpoint;
    this.status = opts.status;
    this.statusText = opts.statusText;
    this.ret = opts.ret;
    this.errcode = opts.errcode;
    this.errmsg = opts.errmsg;
    this.responseBody = opts.responseBody;
    this.timedOut = opts.timedOut ?? false;
  }

  get code(): number | undefined {
    return this.errcode ?? this.ret ?? this.status;
  }
}
