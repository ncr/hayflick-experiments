export * from "./registry";
export * from "./runtime/meta";
export * from "./runtime/types";
// auto-collider is intentionally NOT re-exported here. It pulls THREE plus
// every strategy module into the dep graph of anyone who imports from the
// package index — including the hub's App shell. Consumers that need the
// collider API import it via the subpath: `@experiments/catalog/auto-collider`.
