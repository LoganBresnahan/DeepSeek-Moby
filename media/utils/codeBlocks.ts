// Moved to shared/parsing/codeBlocks.ts per ADR 0003. Re-exported here so
// webview-side imports keep working without call-site churn.
export { extractCodeBlocks, hasIncompleteFence, type CodeBlock } from '../../shared/parsing/codeBlocks';
