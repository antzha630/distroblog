// Direct ADK test to debug Google Search tool invocation
// Run: node test-adk-direct.js

const adk = require('@google/adk');

console.log('=== ADK Export Analysis ===\n');

console.log('ADK exports:', Object.keys(adk));

console.log('\n--- GOOGLE_SEARCH ---');
console.log('adk.GOOGLE_SEARCH:', adk.GOOGLE_SEARCH);
console.log('Type:', typeof adk.GOOGLE_SEARCH);

if (adk.GOOGLE_SEARCH) {
  console.log('Keys:', Object.keys(adk.GOOGLE_SEARCH));
  console.log('Stringified:', JSON.stringify(adk.GOOGLE_SEARCH, null, 2).slice(0, 500));
}

console.log('\n--- googleSearch (lowercase) ---');
console.log('adk.googleSearch:', adk.googleSearch);

console.log('\n--- google_search (underscore) ---');
console.log('adk.google_search:', adk.google_search);

console.log('\n--- Tools namespace ---');
if (adk.tools) {
  console.log('adk.tools:', Object.keys(adk.tools));
}
if (adk.Tools) {
  console.log('adk.Tools:', Object.keys(adk.Tools));
}

console.log('\n--- BuiltInTools ---');
if (adk.BuiltInTools) {
  console.log('adk.BuiltInTools:', adk.BuiltInTools);
}

console.log('\n--- LlmAgent ---');
console.log('adk.LlmAgent:', typeof adk.LlmAgent);
if (adk.LlmAgent) {
  console.log('LlmAgent.prototype keys:', Object.getOwnPropertyNames(adk.LlmAgent.prototype));
}
