import { buildCatalogServer } from '@discord-mcp/core';
import type { Transport } from '@modelcontextprotocol/server';
import { type StdioServerHandle, serveStdio } from '@modelcontextprotocol/server/stdio';

/**
 * The catalog server deliberately has no Discord runtime dependencies. Keep
 * this boundary small so schema discovery cannot load the normal REST,
 * Gateway, profile, configuration, or OpenTelemetry path.
 */
export interface CatalogStartOptions {
  /** A supplied transport is useful for in-process integration tests. */
  transport?: Transport;
  /** Disable process signal hooks in tests that own the process lifecycle. */
  registerSignalHandlers?: boolean;
}

/**
 * Start the catalog-only MCP server over stdio.
 *
 * No config is loaded here: in particular, DISCORD_TOKEN, GATEWAY, and
 * OTEL_ENABLED are intentionally irrelevant to this transport.
 */
export async function startCatalog(opts: CatalogStartOptions = {}): Promise<void> {
  const initialBuild = await buildCatalogServer();
  let activeBuild = initialBuild;
  const catalogBuilds = [initialBuild];
  const usedBuilds = new Set<typeof initialBuild>();
  let stdioHandle: StdioServerHandle | undefined;
  if (opts.transport !== undefined) {
    usedBuilds.add(initialBuild);
    await initialBuild.server.connect(opts.transport);
  } else {
    stdioHandle = serveStdio(
      async ({ era }) => {
        const build = await buildCatalogServer({ enableResourceSubscriptions: era === 'legacy' });
        catalogBuilds.push(build);
        activeBuild = build;
        usedBuilds.add(build);
        return build.server;
      },
      {
        legacy: 'serve',
        onerror: (error) =>
          process.stderr.write(`discord-mcp catalog stdio failed: ${error.message}\n`),
      },
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    try {
      await (stdioHandle?.close() ?? activeBuild.server.close());
      await Promise.all(
        catalogBuilds
          .filter((build) => !usedBuilds.has(build))
          .map((build) => build.server.close()),
      );
      await initialBuild.auditSink.shutdown?.();
      process.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`discord-mcp catalog failed to close on ${signal}: ${message}\n`);
      process.exit(1);
    }
  };

  if (opts.registerSignalHandlers !== false) {
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  }
}
