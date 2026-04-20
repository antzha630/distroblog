// Test ADK FunctionTool availability
const adk = require('@google/adk');

console.log('=== ADK FunctionTool Test ===\n');
console.log('ADK version check...');
console.log('All ADK exports:', Object.keys(adk).sort());

console.log('\n--- FunctionTool ---');
console.log('adk.FunctionTool:', adk.FunctionTool);
console.log('Type:', typeof adk.FunctionTool);

if (adk.FunctionTool) {
  try {
    // Test creating a simple FunctionTool
    const testTool = new adk.FunctionTool({
      name: 'test_search',
      description: 'Test search tool',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
      },
      execute: async ({ query }) => {
        return { result: `Searched for: ${query}` };
      }
    });
    console.log('FunctionTool created successfully:', testTool);
    console.log('Tool type:', typeof testTool);
    console.log('Tool keys:', Object.keys(testTool));
  } catch (e) {
    console.log('Error creating FunctionTool:', e.message);
  }
}

console.log('\n--- Alternative: defineTool ---');
console.log('adk.defineTool:', adk.defineTool);

console.log('\n--- Alternative: Tool ---');
console.log('adk.Tool:', adk.Tool);

console.log('\n--- GoogleSearchTool ---');
console.log('adk.GoogleSearchTool:', adk.GoogleSearchTool);
console.log('adk.googleSearchTool:', adk.googleSearchTool);
