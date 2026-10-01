import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { withAudit, type AuditRecorder, type Db, type RequestContext, type Tx } from '@khalta/db';
import { roleCan, type Capability } from '@khalta/rbac';
import express, { Router, type Request, type Response } from 'express';
import type { ZodType } from 'zod';
import type { AuthContext } from './middleware';
import { forbidden } from './errors';

interface Opts<B, P, Q> {
  summary: string;
  /** Capability required; `null` = any authenticated user. */
  capability: Capability | null;
  body?: ZodType<B>;
  params?: ZodType<P>;
  query?: ZodType<Q>;
  status?: number;
}

interface ReadArgs<P, Q> {
  auth: AuthContext;
  params: P;
  query: Q;
  db: Db;
}
interface MutateArgs<B, P> {
  auth: AuthContext;
  body: B;
  params: P;
  tx: Tx;
  audit: AuditRecorder;
}

const SAFE = new Set(['get', 'head', 'options']);

/**
 * The only way API routes are declared. Reads run on the pool; mutations are wrapped in `withAudit`
 * (one transaction with their audit rows) and recorded in `mutationRoutes` so a test can prove no
 * non-GET route bypasses it. Every route also lands in the OpenAPI document.
 */
export class ApiRoutes {
  readonly router = Router();
  readonly registry = new OpenAPIRegistry();
  readonly mutationRoutes = new Set<string>();
  /** POST routes that only read (the body carries the query). They write nothing, so they bypass withAudit; listed so tests can prove it. */
  readonly readOnlyPosts = new Set<string>();
  /** Every declared route with the capability it needs (drives the generated RBAC tests). */
  readonly routes: { method: string; path: string; capability: Capability | null }[] = [];

  constructor(private readonly db: Db) {}

  private authorize(auth: AuthContext, capability: Capability | null) {
    if (capability && !roleCan(auth.role, capability, auth.settings)) throw forbidden();
  }

  private document(method: string, path: string, o: Opts<unknown, unknown, unknown>) {
    this.routes.push({ method: method.toUpperCase(), path, capability: o.capability });
    const request: Record<string, unknown> = {};
    if (o.body) request['body'] = { content: { 'application/json': { schema: o.body } } };
    this.registry.registerPath({
      method: method as 'get',
      path: path.replace(/:(\w+)/g, '{$1}'),
      summary: o.summary,
      description: o.capability
        ? `Requires capability \`${o.capability}\`.`
        : 'Any authenticated user.',
      request: request as never,
      responses: { [o.status ?? 200]: { description: 'OK' } },
    });
  }

  get<P = unknown, Q = unknown>(
    path: string,
    o: Opts<never, P, Q>,
    handler: (a: ReadArgs<P, Q>) => Promise<unknown>,
  ) {
    this.document('get', path, o);
    this.router.get(path, async (req: Request, res: Response) => {
      const auth = res.locals['auth'] as AuthContext;
      this.authorize(auth, o.capability);
      const params = (o.params ? o.params.parse(req.params) : req.params) as P;
      const query = (o.query ? o.query.parse(req.query) : req.query) as Q;
      res.status(o.status ?? 200).json(await handler({ auth, params, query, db: this.db }));
    });
  }

  /** A read-only operation that needs a request body (e.g. "resolve rules for this context"). */
  readPost<B = undefined>(
    path: string,
    o: Opts<B, unknown, never>,
    handler: (a: ReadArgs<unknown, unknown> & { body: B }) => Promise<unknown>,
  ) {
    this.document('post', path, o);
    this.readOnlyPosts.add(`POST ${path}`);
    this.router.post(path, async (req: Request, res: Response) => {
      const auth = res.locals['auth'] as AuthContext;
      this.authorize(auth, o.capability);
      const body = (o.body ? o.body.parse(req.body) : undefined) as B;
      res
        .status(o.status ?? 200)
        .json(await handler({ auth, params: req.params, query: req.query, db: this.db, body }));
    });
  }

  mutate<B = undefined, P = unknown>(
    method: 'post' | 'put' | 'patch' | 'delete',
    path: string,
    o: Opts<B, P, never>,
    handler: (a: MutateArgs<B, P>) => Promise<unknown>,
  ) {
    if (SAFE.has(method)) throw new Error('mutate() is for non-GET methods');
    this.document(method, path, o);
    this.mutationRoutes.add(`${method.toUpperCase()} ${path}`);
    this.router[method](path, async (req: Request, res: Response) => {
      const auth = res.locals['auth'] as AuthContext;
      this.authorize(auth, o.capability);
      const params = (o.params ? o.params.parse(req.params) : req.params) as P;
      const body = (o.body ? o.body.parse(req.body) : undefined) as B;
      const ctx: RequestContext = auth.ctx;
      const result = await withAudit(this.db, ctx, (tx, audit) =>
        handler({ auth, body, params, tx, audit }),
      );
      res.status(o.status ?? 200).json(result ?? { ok: true });
    });
  }

  /** Audited binary upload (raw request body, `limit` bytes). Metadata travels in the query string. */
  upload<Q = unknown>(
    path: string,
    o: Opts<never, unknown, Q> & { limitBytes: number },
    handler: (a: MutateArgs<Buffer, unknown> & { query: Q }) => Promise<unknown>,
  ) {
    this.document('post', path, o);
    this.mutationRoutes.add(`POST ${path}`);
    this.router.post(
      path,
      express.raw({ type: () => true, limit: o.limitBytes }),
      async (req: Request, res: Response) => {
        const auth = res.locals['auth'] as AuthContext;
        this.authorize(auth, o.capability);
        const query = (o.query ? o.query.parse(req.query) : req.query) as Q;
        // A non-binary body (e.g. JSON already parsed upstream) is treated as an empty upload.
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const result = await withAudit(this.db, auth.ctx, (tx, audit) =>
          handler({ auth, body, params: req.params, query, tx, audit }),
        );
        res.status(o.status ?? 201).json(result ?? { ok: true });
      },
    );
  }

  /** Authorized file download. Always `attachment`, never sniffed, never cached by shared caches. */
  file<P = unknown>(
    path: string,
    o: Opts<never, P, never>,
    handler: (a: ReadArgs<P, unknown>) => Promise<{ filename: string; contentType: string; data: Buffer }>,
  ) {
    this.document('get', path, o);
    this.router.get(path, async (req: Request, res: Response) => {
      const auth = res.locals['auth'] as AuthContext;
      this.authorize(auth, o.capability);
      const params = (o.params ? o.params.parse(req.params) : req.params) as P;
      const f = await handler({ auth, params, query: req.query, db: this.db });
      res
        .status(200)
        .set({
          'Content-Type': f.contentType,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        })
        .send(f.data);
    });
  }

  openApiDocument() {
    return new OpenApiGeneratorV31(this.registry.definitions).generateDocument({
      openapi: '3.1.0',
      info: { title: 'Khalta API', version: '0.0.0' },
    });
  }
}
