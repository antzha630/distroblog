const OpenAI = require('openai');

class LLMService {
  constructor() {
    this.openai = null;
    this.initializeOpenAI();
  }

  initializeOpenAI() {
    const apiKey = process.env.OPENAI_API_KEY;
    
    if (!apiKey) {
      console.warn('OpenAI API key not found. LLM summarization will be disabled.');
      return;
    }

    try {
      this.openai = new OpenAI({
        apiKey: apiKey
      });
      console.log('OpenAI client initialized successfully');
    } catch (error) {
      console.error('Error initializing OpenAI client:', error.message);
    }
  }

  async summarizeArticle(title, content, sourceName) {
    if (!this.openai) {
      // Fallback to simple truncation if OpenAI is not available
      return this.fallbackSummary(content);
    }

    try {
      const prompt = this.createSummaryPrompt(title, content, sourceName);
      
      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: `You are a professional fact-checker and news summarizer for journalists. 
                     Your role is to create accurate, concise summaries that help journalists quickly understand news content.
                     CRITICAL RULES:
                     - Only include factual information directly stated in the source
                     - Preserve all quotes, names, dates, and numbers exactly as written
                     - If no substantial factual content exists, respond with "NO FACTUAL CONTENT"
                     - Never add interpretation, analysis, or external context
                     - Keep summaries under 150 words
                     - Focus on who, what, when, where, and how much`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 200,
        temperature: 0.1, // Low temperature for factual accuracy
        presence_penalty: 0,
        frequency_penalty: 0
      });

      const summary = response.choices[0]?.message?.content?.trim();
      
      if (!summary || summary === 'NO FACTUAL CONTENT') {
        return this.fallbackSummary(content);
      }

      return summary;

    } catch (error) {
      console.error('Error generating LLM summary:', error.message);
      return this.fallbackSummary(content);
    }
  }

  createSummaryPrompt(title, content, sourceName) {
    // Check if content is just a URL or very minimal content
    if (!content || content.trim().length < 50 || content.trim().match(/^https?:\/\/[^\s]+$/)) {
      return `Source: ${sourceName}
Title: ${title}
Link: ${content || 'No content available'}

Instructions:
This appears to be a link-only or minimal content article. Create a brief summary based on the title that would be useful for journalists. If the title suggests it's a community highlight, announcement, or update, mention that. Keep it under 50 words and focus on what journalists would find newsworthy about this title.`;
    }

    return `Source: ${sourceName}
Title: ${title}

Article content to summarize:
${content}

Instructions:
1. Create a concise summary of the key facts from this ${sourceName} article
2. Focus on the main news story, announcement, or development
3. Include specific numbers, dates, names, and quotes that are directly stated
4. Keep the summary under 150 words and make it journalist-friendly
5. Do NOT repeat the title in the summary
6. Do NOT include metadata, navigation text, or promotional content
7. If the content appears to be mostly metadata or lacks substantial news value, respond with "NO FACTUAL CONTENT"
8. Maintain journalistic objectivity - only factual information from the source`;
  }

  fallbackSummary(content) {
    if (!content || content.length < 100) {
      return content;
    }

    // Clean content before creating fallback summary
    let cleaned = content;
    
    // Remove common metadata patterns for fallback
    const metadataPatterns = [
      /Category:\s*[\w\s,]+\s+\w{3}\s+\d{1,2},\s*\d{4}/gi,
      /Category:\s*[\w\s,]+/gi,
      /\w{3}\s+\d{1,2},\s*\d{4}/g,
      /By\s+[\w\s]+,\s*\w{3}\s+\d{1,2},\s*\d{4}/gi,
      /Author:\s*[\w\s]+/gi,
      /Tags?:\s*[\w\s,]+/gi,
      /Read more\s*→?/gi,
      /Continue reading\s*→?/gi,
      /View all articles/gi,
      /Related Articles/gi,
    ];
    
    metadataPatterns.forEach(pattern => {
      cleaned = cleaned.replace(pattern, '');
    });

    // Simple extractive summary - take first few meaningful sentences
    const sentences = cleaned.split(/[.!?]+/).filter(s => {
      const trimmed = s.trim();
      return trimmed.length > 20 && 
             !/^[A-Z][a-z]+:\s/.test(trimmed) &&  // Not metadata lines
             !/^\d{4}-\d{2}-\d{2}/.test(trimmed); // Not date lines
    });
    
    const summary = sentences.slice(0, 3).join('. ').trim();
    
    return summary.length > 300 ? summary.substring(0, 297) + '...' : summary + '.';
  }

  async isContentSignificant(content, sourceName) {
    // Simple heuristic to determine if content is newsworthy
    // In a production system, this could be more sophisticated
    
    const significantIndicators = [
      'breaking', 'urgent', 'announcement', 'report', 'statement',
      'new', 'first', 'major', 'investigation', 'exclusive',
      'update', 'development', 'policy', 'decision', 'approval'
    ];

    const lowerContent = content.toLowerCase();
    const hasSignificantWords = significantIndicators.some(word => 
      lowerContent.includes(word)
    );

    // Additional checks
    const hasNumbers = /\d+/.test(content);
    const hasQuotes = content.includes('"') || content.includes('"');
    const hasProperNouns = /[A-Z][a-z]+ [A-Z][a-z]+/.test(content);
    const sufficientLength = content.length > 200;

    // Score the content
    let score = 0;
    if (hasSignificantWords) score += 2;
    if (hasNumbers) score += 1;
    if (hasQuotes) score += 2;
    if (hasProperNouns) score += 1;
    if (sufficientLength) score += 1;

    return score >= 3; // Threshold for significance
  }

  async batchSummarize(articles) {
    // For efficiency, process multiple articles in smaller batches
    const batchSize = 5;
    const results = [];
    
    for (let i = 0; i < articles.length; i += batchSize) {
      const batch = articles.slice(i, i + batchSize);
      const batchPromises = batch.map(article => 
        this.summarizeArticle(article.title, article.content, article.sourceName)
      );
      
      try {
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
      } catch (error) {
        console.error('Error in batch summarization:', error);
        // Fallback to individual processing for this batch
        for (const article of batch) {
          try {
            const summary = await this.summarizeArticle(article.title, article.content, article.sourceName);
            results.push(summary);
          } catch (err) {
            results.push(this.fallbackSummary(article.content));
          }
        }
      }
      
      // Rate limiting - wait between batches
      if (i + batchSize < articles.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return results;
  }

  async generateDescription(title, content) {
    if (!this.openai) {
      // Fallback to simple truncation if OpenAI is not available
      return this.fallbackDescription(title, content);
    }

    try {
      const prompt = `Create a brief, engaging description for this article that would be suitable for a news feed:

Title: ${title}
Content: ${content.substring(0, 500)}...

Instructions:
- Write 1-2 sentences that capture the main point
- Keep it under 100 words
- Make it engaging and informative
- Focus on the key news value or story
- Avoid repeating the title exactly`;

      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'You are a professional news editor creating brief, engaging descriptions for news articles. Be concise, accurate, and engaging.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 150,
        temperature: 0.3
      });

      const description = response.choices[0]?.message?.content?.trim();
      return description || this.fallbackDescription(title, content);

    } catch (error) {
      console.error('Error generating AI description:', error.message);
      return this.fallbackDescription(title, content);
    }
  }

  fallbackDescription(title, content) {
    if (!content || content.length < 50) {
      return `Read more about: ${title}`;
    }

    // Simple extractive description - take first meaningful sentence
    const sentences = content.split(/[.!?]+/).filter(s => {
      const trimmed = s.trim();
      return trimmed.length > 20 && trimmed.length < 200;
    });
    
    if (sentences.length > 0) {
      return sentences[0].trim() + '.';
    }
    
    return `Read more about: ${title}`;
  }

  // Method to test LLM connectivity
  async testConnection() {
    if (!this.openai) {
      return { success: false, error: 'OpenAI client not initialized' };
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Test connection. Reply with "OK".' }],
        max_tokens: 5
      });

      return { 
        success: true, 
        response: response.choices[0]?.message?.content 
      };
    } catch (error) {
      return { 
        success: false, 
        error: error.message 
      };
    }
  }
}

module.exports = new LLMService();