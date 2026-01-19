import React, { useState, useRef, useEffect } from 'react';
import config from '../config';
import './ADKWeb.css';

function ADKWeb() {
  const [url, setUrl] = useState('');
  const [customInstruction, setCustomInstruction] = useState(`You help a journalist by returning exactly 3 of the most recent blog posts or articles from a given site. Use the Google Search tool and return only a JSON array with objects: title, url, description, datePublished.

Rules (must follow all):
- Hostname must match the target domain; reject other domains.
- URL must point to an article page with a meaningful path (length >= 11 chars); reject home/about/contact/privacy/terms/team/careers/docs/login/signup/dashboard/app or other generic pages.
- No Google redirect URLs (vertexaisearch / grounding / google.com/grounding).
- Prefer canonical/short article URLs over long slugs when both appear.
- Title must be non-null, non-empty, and not generic (not "Blog" or "Home").
- datePublished: use ISO (YYYY-MM-DD or with time) when visible in search; null if truly unavailable.
- Sort newest first.
Return only the JSON array, nothing else.`);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [events, setEvents] = useState([]);
  const [sessionId] = useState(() => `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
  const [viewMode, setViewMode] = useState('events'); // 'events' or 'trace'
  const [activeTab, setActiveTab] = useState('events'); // 'events', 'runs', 'artifacts', 'sessions', 'eval'
  const chatEndRef = useRef(null);
  const eventsEndRef = useRef(null);

  // Auto-scroll chat to bottom when new messages arrive
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversations]);

  // Auto-scroll events to bottom when new events arrive
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const handleSendMessage = async () => {
    if (!url.trim()) {
      setError('Please enter a website URL');
      return;
    }

    const userMessage = `Find articles from: ${url}`;
    
    // Add user message to conversation
    const newConversation = {
      id: Date.now(),
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString()
    };
    setConversations(prev => [...prev, newConversation]);

    // Add to events
    const userEvent = {
      id: `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      number: events.length + 1,
      type: 'user',
      content: userMessage,
      timestamp: new Date().toISOString()
    };
    setEvents(prev => [...prev, userEvent]);

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${config.API_BASE_URL}/api/adk/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: url.trim(),
          customInstruction: customInstruction.trim() || undefined
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to test ADK agent');
      }

      setResult(data);

      // Add function call events
      if (data.debugInfo?.functionCalls) {
        data.debugInfo.functionCalls.forEach((fc, idx) => {
          setEvents(prev => [...prev, {
            id: `fc-${Date.now()}-${idx}`,
            number: prev.length + 1,
            type: 'function_call',
            name: fc.name,
            args: fc.args,
            timestamp: new Date().toISOString()
          }]);
        });
      }

      // Add function response events
      if (data.debugInfo?.functionResponses) {
        data.debugInfo.functionResponses.forEach((fr, idx) => {
          setEvents(prev => [...prev, {
            id: `fr-${Date.now()}-${idx}`,
            number: prev.length + 1,
            type: 'function_response',
            name: fr.name,
            response: fr.response,
            timestamp: new Date().toISOString()
          }]);
        });
      }

      // Add agent response to conversation
      const agentMessage = data.articles && data.articles.length > 0
        ? `Found ${data.articles.length} articles:\n${data.articles.map((a, i) => `${i + 1}. ${a.title}`).join('\n')}`
        : (data.debugInfo?.rawResponse || 'No articles found in response.');

      const agentConversation = {
        id: Date.now() + 1,
        role: 'agent',
        content: agentMessage,
        articles: data.articles || [],
        rawResponse: data.debugInfo?.rawResponse,
        timestamp: new Date().toISOString()
      };
      setConversations(prev => [...prev, agentConversation]);

      // Add agent event
      const agentEvent = {
        id: `agent-${Date.now()}`,
        number: events.length + (data.debugInfo?.functionCalls?.length || 0) + (data.debugInfo?.functionResponses?.length || 0) + 1,
        type: 'agent',
        content: agentMessage,
        timestamp: new Date().toISOString()
      };
      setEvents(prev => [...prev, agentEvent]);

    } catch (err) {
      setError(err.message);
      const errorConversation = {
        id: Date.now() + 1,
        role: 'agent',
        content: `Error: ${err.message}`,
        isError: true,
        timestamp: new Date().toISOString()
      };
      setConversations(prev => [...prev, errorConversation]);
    } finally {
      setLoading(false);
    }
  };

  const handleNewSession = () => {
    setConversations([]);
    setEvents([]);
    setResult(null);
    setError(null);
    setUrl('');
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="adk-web-container">
      {/* Header Bar */}
      <div className="adk-web-header-bar">
        <div className="header-left">
          <div className="agent-selector">
            <select className="agent-dropdown">
              <option>article_finder</option>
            </select>
          </div>
        </div>
        <div className="header-center">
          <span className="session-label">SESSION ID</span>
          <span className="session-id">{sessionId}</span>
          <button className="session-refresh" title="Refresh">
            <span>↻</span>
          </button>
        </div>
        <div className="header-right">
          <label className="token-streaming-toggle">
            <input type="checkbox" />
            <span>Token streaming</span>
          </label>
          <button className="new-session-btn" onClick={handleNewSession}>
            + New Session
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="adk-web-main">
        {/* Left Panel - Events/Trace */}
        <div className="adk-web-left-panel">
          <div className="left-panel-tabs">
            <button 
              className={`tab-btn ${activeTab === 'events' ? 'active' : ''}`}
              onClick={() => setActiveTab('events')}
            >
              Events
            </button>
            <button 
              className={`tab-btn ${activeTab === 'runs' ? 'active' : ''}`}
              onClick={() => setActiveTab('runs')}
            >
              Runs
            </button>
            <button 
              className={`tab-btn ${activeTab === 'artifacts' ? 'active' : ''}`}
              onClick={() => setActiveTab('artifacts')}
            >
              Artifacts
            </button>
            <button 
              className={`tab-btn ${activeTab === 'sessions' ? 'active' : ''}`}
              onClick={() => setActiveTab('sessions')}
            >
              Sessions
            </button>
            <button 
              className={`tab-btn ${activeTab === 'eval' ? 'active' : ''}`}
              onClick={() => setActiveTab('eval')}
            >
              Eval
            </button>
          </div>

          {activeTab === 'events' && (
            <>
              <div className="panel-title">Conversations with agent</div>
              <div className="view-toggle">
                <button 
                  className={`toggle-btn ${viewMode === 'events' ? 'active' : ''}`}
                  onClick={() => setViewMode('events')}
                >
                  Events
                </button>
                <button 
                  className={`toggle-btn ${viewMode === 'trace' ? 'active' : ''}`}
                  onClick={() => setViewMode('trace')}
                >
                  Trace
                </button>
              </div>
              <div className="events-list">
                {events.length === 0 ? (
                  <div className="empty-state">No conversations yet. Start a conversation on the right.</div>
                ) : (
                  events.map((event, idx) => (
                    <div key={event.id} className={`event-item event-${event.type}`}>
                      <div className="event-number">{event.number}</div>
                      <div className="event-content">
                        {event.type === 'user' && (
                          <div className="event-user">
                            <span className="event-icon">👤</span>
                            <span>User: {event.content}</span>
                          </div>
                        )}
                        {event.type === 'function_call' && (
                          <div className="event-function-call">
                            <span className="event-icon">🔧</span>
                            <span className="event-function-name">FUNCTION_CALL: {event.name}</span>
                            {event.args && (
                              <details className="event-details">
                                <summary>Arguments</summary>
                                <pre>{JSON.stringify(event.args, null, 2)}</pre>
                              </details>
                            )}
                          </div>
                        )}
                        {event.type === 'function_response' && (
                          <div className="event-function-response">
                            <span className="event-icon">✓</span>
                            <span className="event-function-name">function_response: {event.name}</span>
                            {event.response && (
                              <details className="event-details">
                                <summary>Response</summary>
                                <pre>{typeof event.response === 'string' ? event.response.substring(0, 500) : JSON.stringify(event.response, null, 2).substring(0, 500)}</pre>
                              </details>
                            )}
                          </div>
                        )}
                        {event.type === 'agent' && (
                          <div className="event-agent">
                            <span className="event-icon">🤖</span>
                            <span>Agent: {event.content.substring(0, 200)}{event.content.length > 200 ? '...' : ''}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
                <div ref={eventsEndRef} />
              </div>
            </>
          )}

          {activeTab === 'artifacts' && result && (
            <div className="artifacts-view">
              <div className="panel-title">Articles Found</div>
              {result.articles && result.articles.length > 0 ? (
                <div className="artifacts-list">
                  {result.articles.map((article, idx) => (
                    <div key={idx} className="artifact-item">
                      <h4>{article.title || 'Untitled'}</h4>
                      <div className="artifact-meta">
                        <div><strong>URL:</strong> <a href={article.url || article.link} target="_blank" rel="noopener noreferrer">{article.url || article.link}</a></div>
                        {article.datePublished && <div><strong>Published:</strong> {article.datePublished}</div>}
                        {article.description && <div><strong>Description:</strong> {article.description.substring(0, 200)}...</div>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">No articles found</div>
              )}
            </div>
          )}

          {(activeTab === 'runs' || activeTab === 'sessions' || activeTab === 'eval') && (
            <div className="panel-title">Feature coming soon</div>
          )}
        </div>

        {/* Right Panel - Chat Interface */}
        <div className="adk-web-right-panel">
          <div className="chat-messages">
            {conversations.length === 0 ? (
              <div className="chat-empty-state">
                <div className="empty-icon">🤖</div>
                <div className="empty-text">Click to talk to your agent</div>
                <div className="empty-hint">Enter a website URL below and click Send to test the agent</div>
              </div>
            ) : (
              conversations.map((conv) => (
                <div key={conv.id} className={`chat-message chat-${conv.role} ${conv.isError ? 'chat-error' : ''}`}>
                  <div className="chat-avatar">
                    {conv.role === 'user' ? '👤' : '🤖'}
                  </div>
                  <div className="chat-content">
                    <div className="chat-text">{conv.content}</div>
                    
                    {/* Show articles if available */}
                    {conv.articles && conv.articles.length > 0 && (
                      <div className="chat-articles">
                        {conv.articles.map((article, idx) => (
                          <div key={idx} className="article-bubble">
                            <div className="article-icon">📄</div>
                            <div className="article-info">
                              <div className="article-title">{article.title}</div>
                              <div className="article-url">
                                <a href={article.url || article.link} target="_blank" rel="noopener noreferrer">
                                  {article.url || article.link}
                                </a>
                              </div>
                              {article.datePublished && (
                                <div className="article-date">{article.datePublished}</div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Show function calls in chat */}
                    {result && result.debugInfo?.functionCalls && conv.role === 'agent' && (
                      result.debugInfo.functionCalls.map((fc, idx) => (
                        <div key={idx} className="function-call-bubble">
                          <span className="function-icon">✓</span>
                          <span className="function-name"># {fc.name}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ))
            )}
            {loading && (
              <div className="chat-message chat-agent">
                <div className="chat-avatar">🤖</div>
                <div className="chat-content">
                  <div className="chat-text loading">Thinking...</div>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="chat-input-area">
            <div className="input-prompt-section">
              <div className="input-group">
                <label>Website URL:</label>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="https://example.com"
                  className="url-input"
                  disabled={loading}
                />
              </div>
              <details className="prompt-editor">
                <summary>Edit Agent Instruction (Advanced)</summary>
                <textarea
                  value={customInstruction}
                  onChange={(e) => setCustomInstruction(e.target.value)}
                  placeholder="Enter custom agent instruction..."
                  rows={10}
                  className="instruction-textarea"
                  disabled={loading}
                />
              </details>
            </div>
            <div className="chat-input-row">
              <input
                type="text"
                value={`Find articles from: ${url || ''}`}
                readOnly
                className="chat-input-readonly"
              />
              <div className="chat-actions">
                <button className="action-btn" title="Attach">
                  📎
                </button>
                <button 
                  className="send-btn"
                  onClick={handleSendMessage}
                  disabled={loading || !url.trim()}
                >
                  {loading ? '⏳' : '✈️'}
                </button>
              </div>
            </div>
            {error && (
              <div className="error-banner">
                <strong>Error:</strong> {error}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ADKWeb;
