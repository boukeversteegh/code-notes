#!/usr/bin/env node
// Global entry point: registers the tsx loader so the TypeScript sources run without a build step.
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
