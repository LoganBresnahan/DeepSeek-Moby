/**
 * DSML Parser - Parses DeepSeek Markup Language tool calls
 *
 * DeepSeek Chat outputs tool calls in a custom DSML format instead of
 * using the standard OpenAI function calling API format. This parser
 * extracts tool calls from DSML content and converts them to a standard format.
 *
 * Example DSML:
 * <｜DSML｜function_calls> <｜DSML｜invoke name="read_file"> <｜DSML｜parameter name="path" string="true">file.txt</｜DSML｜parameter> </｜DSML｜invoke> </｜DSML｜function_calls>
 */

export interface DSMLToolCall {
  id: string;
  name: string;
  arguments: Record<string, string>;
}

/**
 * Parse DSML-formatted tool calls from content string
 * @param content The response content that may contain DSML
 * @returns Array of parsed tool calls, or null if no DSML found
 */
export function parseDSMLToolCalls(content: string): DSMLToolCall[] | null {
  if (!content || !containsDSML(content)) {
    return null;
  }

  // Match DSML function_calls blocks - handle both closing tag formats
  // Some responses use </｜DSML｜function_calls> and some might not have proper closing
  const funcCallMatch = content.match(/<｜DSML｜function_calls>([\s\S]*?)(?:<\/｜DSML｜function_calls>|$)/);
  if (!funcCallMatch) {
    return null;
  }

  const toolCalls: DSMLToolCall[] = [];

  // Match invoke blocks - handle both closing tag formats
  const invokeRegex = /<｜DSML｜invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)(?:<\/｜DSML｜invoke>|(?=<｜DSML｜invoke)|$)/g;

  // Match parameter blocks
  const paramRegex = /<｜DSML｜parameter\s+name="([^"]+)"[^>]*>([^<]*)<｜DSML｜parameter>/g;

  let invokeMatch;
  let idCounter = 0;

  while ((invokeMatch = invokeRegex.exec(funcCallMatch[1])) !== null) {
    const name = invokeMatch[1];
    const paramsBlock = invokeMatch[2];
    const args: Record<string, string> = {};

    // Reset lastIndex for paramRegex since we reuse it
    paramRegex.lastIndex = 0;

    let paramMatch;
    while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
      const paramName = paramMatch[1];
      const paramValue = paramMatch[2].trim();
      args[paramName] = paramValue;
    }

    toolCalls.push({
      id: `dsml_call_${idCounter++}_${Date.now()}`,
      name,
      arguments: args
    });
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

/**
 * Check if content contains DSML markup
 * @param content The content to check
 * @returns true if DSML is present
 */
export function containsDSML(content: string): boolean {
  return content.includes('<｜DSML｜');
}

/**
 * Remove DSML markup from content, leaving any regular text
 * @param content The content with DSML to strip
 * @returns Content with DSML removed
 */
export function stripDSML(content: string): string {
  // Remove the entire function_calls block
  let stripped = content.replace(/<｜DSML｜function_calls>[\s\S]*?(?:<\/｜DSML｜function_calls>|$)/g, '');

  // Also remove any standalone DSML tags that might be left
  stripped = stripped.replace(/<｜DSML｜[^>]*>[\s\S]*?<｜DSML｜[^>]*>/g, '');
  stripped = stripped.replace(/<\/?｜DSML｜[^>]*>/g, '');

  return stripped.trim();
}
