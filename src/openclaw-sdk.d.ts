declare module "openclaw/plugin-sdk/file-access-runtime" {
  export function isPathStrictlyInside(root: string, target: string): boolean;
}

declare module "openclaw/plugin-sdk/memory-core-host-runtime-core" {
  export function readMemoryArtifactProvenance(params: {
    workspaceDir: string;
    relativePath: string;
  }): Promise<{ fileHash: string; originClass: "agent" | "untrusted"; observedAt: number } | undefined>;
}
