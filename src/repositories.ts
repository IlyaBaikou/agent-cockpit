import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export type VerificationCommand = {
  command: string;
  args?: string[];
};

type RepositoryConfigValue =
  | string
  | {
      path: string;
      baseRef?: string;
      verify?: VerificationCommand[];
    };

type RepositoryConfig = Record<string, RepositoryConfigValue>;

export type RepositoryDefinition = {
  alias: string;
  path: string;
  baseRef: string;
  verify: VerificationCommand[];
};

export class RepositoryRegistry {
  readonly #configPath: string;
  #repositories = new Map<string, RepositoryDefinition>();

  constructor(configPath?: string) {
    this.#configPath = resolve(
      configPath ?? process.env.AGENT_HUB_REPOSITORIES_FILE ?? resolve(process.cwd(), "config/repositories.json"),
    );
  }

  async load(): Promise<void> {
    const raw = await readFile(this.#configPath, "utf8");
    const config = JSON.parse(raw) as RepositoryConfig;
    const base = dirname(this.#configPath);

    const entries = await Promise.all(
      Object.entries(config).map(async ([alias, configured]) => {
        const configuredPath = typeof configured === "string" ? configured : configured.path;
        const candidate = isAbsolute(configuredPath) ? configuredPath : resolve(base, configuredPath);
        const canonical = await realpath(candidate);
        const metadata = await stat(canonical);
        if (!metadata.isDirectory()) {
          throw new Error(`Repository '${alias}' is not a directory: ${canonical}`);
        }
        return [
          alias,
          {
            alias,
            path: canonical,
            baseRef: typeof configured === "string" ? "HEAD" : (configured.baseRef ?? "HEAD"),
            verify: typeof configured === "string" ? [] : (configured.verify ?? []),
          },
        ] as const;
      }),
    );
    this.#repositories = new Map(entries);
  }

  resolve(alias: string): string {
    return this.get(alias).path;
  }

  get(alias: string): RepositoryDefinition {
    const repository = this.#repositories.get(alias);
    if (!repository) {
      throw new Error(`Unknown repository '${alias}'. Available: ${this.aliases().join(", ")}`);
    }
    return repository;
  }

  aliases(): string[] {
    return [...this.#repositories.keys()].sort();
  }
}
