import React, { useState, useEffect } from 'react';
import axios from 'axios';

function SourceManager({ onSourceAdded, onSourceRemoved }) {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newSource, setNewSource] = useState({
    url: '',
    name: '',
    category: 'general'
  });
  const [isValidating, setIsValidating] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [detectedFeeds, setDetectedFeeds] = useState([]);
  const [isDetecting, setIsDetecting] = useState(false);
  const [showDetectedFeeds, setShowDetectedFeeds] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(null);
  const [isRemoving, setIsRemoving] = useState(false);

  useEffect(() => {
    fetchSources();
  }, []);

  const fetchSources = async () => {
    try {
      const response = await axios.get('/api/sources');
      setSources(response.data);
    } catch (error) {
      console.error('Error fetching sources:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDetectFeeds = async () => {
    if (!newSource.url.trim()) {
      setValidationError('Please enter a website URL first');
      return;
    }

    setIsDetecting(true);
    setValidationError('');
    setDetectedFeeds([]);

    try {
      const response = await axios.post('/api/sources/detect', {
        url: newSource.url.trim()
      });
      
      setDetectedFeeds(response.data.feeds);
      setShowDetectedFeeds(true);
      
      if (response.data.feeds.length === 0) {
        setValidationError('No RSS feeds found on this website. Try entering the direct RSS URL.');
      }
    } catch (error) {
      setValidationError(
        error.response?.data?.error || 'Failed to detect RSS feeds'
      );
    } finally {
      setIsDetecting(false);
    }
  };

  const handleSelectDetectedFeed = (feed) => {
    setNewSource({
      ...newSource,
      url: feed.url,
      name: newSource.name || feed.title
    });
    setShowDetectedFeeds(false);
    setDetectedFeeds([]);
  };

  const handleAddSource = async (e) => {
    e.preventDefault();
    setIsValidating(true);
    setValidationError('');

    try {
      await axios.post('/api/sources', newSource);
      
      // Refresh sources list
      await fetchSources();
      
      // Notify parent component that source was added
      if (onSourceAdded) {
        onSourceAdded();
      }
      
      // Reset form
      setNewSource({ url: '', name: '', category: 'general' });
      setShowAddForm(false);
      setDetectedFeeds([]);
      setShowDetectedFeeds(false);
      
    } catch (error) {
      setValidationError(
        error.response?.data?.error || 'Failed to add source'
      );
    } finally {
      setIsValidating(false);
    }
  };

  const handleRemoveSource = async (sourceId, sourceName) => {
    setIsRemoving(true);
    
    try {
      await axios.delete(`/api/sources/${sourceId}`);
      
      // Refresh sources list
      await fetchSources();
      
      // Notify parent component that source was removed
      if (onSourceRemoved) {
        onSourceRemoved();
      }
      
      // Close confirmation dialog
      setShowRemoveConfirm(null);
      
    } catch (error) {
      console.error('Error removing source:', error);
      alert('Failed to remove source. Please try again.');
    } finally {
      setIsRemoving(false);
    }
  };

  const confirmRemoveSource = (source) => {
    setShowRemoveConfirm(source);
  };

  const cancelRemoveSource = () => {
    setShowRemoveConfirm(null);
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleString();
  };

  const getSuccessRateColor = (rate) => {
    if (rate >= 0.8) return '#27ae60';
    if (rate >= 0.6) return '#f39c12';
    return '#e74c3c';
  };

  const getSuccessRateText = (rate) => {
    if (rate === null || rate === undefined) return 'No data';
    return `${Math.round(rate * 100)}%`;
  };

  if (loading) {
    return (
      <div className="card">
        <div className="loading">
          <div className="spinner"></div>
          Loading sources...
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <div className="card-header" style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          marginBottom: '24px',
          paddingBottom: '20px',
          borderBottom: '1px solid #e9ecef'
        }}>
          <h2 className="card-title" style={{ margin: '0 0 16px 0' }}>RSS Source Management</h2>
          <button 
            className="btn btn-primary"
            onClick={() => setShowAddForm(!showAddForm)}
            style={{
              padding: '10px 20px',
              fontSize: '1rem',
              fontWeight: '500'
            }}
          >
            {showAddForm ? 'Cancel' : '+ Add Source'}
          </button>
        </div>

        {showAddForm && (
          <div style={{ 
            padding: '20px', 
            background: '#f8f9fa', 
            borderRadius: '4px', 
            marginBottom: '24px',
            border: '1px solid #e9ecef'
          }}>
            <h3 style={{ marginTop: 0 }}>Add New RSS Source</h3>
            <form onSubmit={handleAddSource}>
              <div className="form-group">
                <label className="form-label">Website or RSS Feed URL *</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="url"
                    className="form-input"
                    value={newSource.url}
                    onChange={(e) => setNewSource({ ...newSource, url: e.target.value })}
                    placeholder="https://example.com or https://example.com/feed.xml"
                    required
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    onClick={handleDetectFeeds}
                    disabled={isDetecting || !newSource.url.trim()}
                    style={{
                      padding: '10px 16px',
                      background: '#17a2b8',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {isDetecting ? (
                      <>
                        <div className="spinner" style={{ width: '12px', height: '12px', marginRight: '4px' }}></div>
                        Detecting...
                      </>
                    ) : (
                      '🔍 Find Feeds'
                    )}
                  </button>
                </div>
                <div style={{ fontSize: '0.8rem', color: '#6c757d', marginTop: '4px' }}>
                  Enter a website URL (like https://techcrunch.com) and we'll find RSS feeds for you, or enter the direct RSS URL
                </div>
              </div>

              {showDetectedFeeds && detectedFeeds.length > 0 && (
                <div style={{ 
                  marginBottom: '20px',
                  padding: '16px',
                  background: '#e3f2fd',
                  borderRadius: '4px',
                  border: '1px solid #bbdefb'
                }}>
                  <h4 style={{ margin: '0 0 12px 0', color: '#1976d2' }}>
                    Found {detectedFeeds.length} RSS Feed{detectedFeeds.length > 1 ? 's' : ''}:
                  </h4>
                  {detectedFeeds.map((feed, index) => (
                    <div 
                      key={index}
                      style={{
                        padding: '12px',
                        background: 'white',
                        borderRadius: '4px',
                        marginBottom: '8px',
                        cursor: 'pointer',
                        border: index === 0 ? '2px solid #4caf50' : '1px solid #e0e0e0',
                        borderLeft: index === 0 ? '4px solid #4caf50' : '1px solid #e0e0e0',
                        transition: 'all 0.2s',
                        position: 'relative'
                      }}
                      onClick={() => handleSelectDetectedFeed(feed)}
                      onMouseEnter={(e) => {
                        if (index !== 0) e.target.style.borderColor = '#1976d2';
                      }}
                      onMouseLeave={(e) => {
                        if (index !== 0) e.target.style.borderColor = '#e0e0e0';
                      }}
                    >
                      {index === 0 && (
                        <div style={{
                          position: 'absolute',
                          top: '-1px',
                          right: '8px',
                          background: '#4caf50',
                          color: 'white',
                          padding: '2px 8px',
                          borderRadius: '0 0 4px 4px',
                          fontSize: '0.7rem',
                          fontWeight: 'bold'
                        }}>
                          RECOMMENDED
                        </div>
                      )}
                      <div style={{ 
                        fontWeight: '500', 
                        marginBottom: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px'
                      }}>
                        {feed.title}
                        {index === 0 && <span style={{ color: '#4caf50', fontSize: '1.2rem' }}>⭐</span>}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: '4px' }}>
                        {feed.url}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#999' }}>
                        {feed.itemCount} articles • {feed.type === 'html_link' ? 'Found in HTML' : 'Common pattern'}
                        {index === 0 && <span style={{ color: '#4caf50', marginLeft: '8px' }}>• Best choice</span>}
                      </div>
                    </div>
                  ))}
                  <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '8px' }}>
                    💡 Click on a feed above to select it
                  </div>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Source Name *</label>
                <input
                  type="text"
                  className="form-input"
                  value={newSource.name}
                  onChange={(e) => setNewSource({ ...newSource, name: e.target.value })}
                  placeholder="e.g., TechCrunch, Reuters Health"
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Category</label>
                <select
                  className="form-select"
                  value={newSource.category}
                  onChange={(e) => setNewSource({ ...newSource, category: e.target.value })}
                >
                  <option value="general">General News</option>
                  <option value="government">Government</option>
                  <option value="business">Business</option>
                  <option value="technology">Technology</option>
                  <option value="health">Health</option>
                  <option value="science">Science</option>
                  <option value="sports">Sports</option>
                  <option value="other">Other</option>
                </select>
              </div>

              {validationError && (
                <div style={{ 
                  padding: '12px', 
                  background: '#fee', 
                  border: '1px solid #fcc',
                  borderRadius: '4px', 
                  color: '#c53030',
                  marginBottom: '16px'
                }}>
                  {validationError}
                </div>
              )}

              <div style={{ display: 'flex', gap: '12px' }}>
                <button 
                  type="submit" 
                  className="btn btn-primary"
                  disabled={isValidating || !newSource.url || !newSource.name}
                >
                  {isValidating ? (
                    <>
                      <div className="spinner"></div>
                      Validating Feed...
                    </>
                  ) : (
                    'Add Source'
                  )}
                </button>
                <button 
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setShowAddForm(false);
                    setValidationError('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {sources.length === 0 ? (
          <div className="empty-state">
            <h3>No Sources Added</h3>
            <p>Add RSS feeds to start monitoring news sources.</p>
          </div>
        ) : (
          <div>
            <div style={{ 
              marginBottom: '20px', 
              fontSize: '1rem', 
              color: '#495057',
              textAlign: 'center',
              fontWeight: '500'
            }}>
              Monitoring {sources.length} sources
            </div>
            
            {sources.map(source => (
              <div key={source.id} style={{
                border: '1px solid #e9ecef',
                borderRadius: '8px',
                padding: '20px',
                marginBottom: '16px',
                background: 'white',
                boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <h3 style={{ margin: '0 0 12px 0', fontSize: '1.2rem', color: '#2c3e50' }}>
                      {source.name}
                    </h3>
                    <div style={{ fontSize: '0.9rem', color: '#6c757d', marginBottom: '12px' }}>
                      <span style={{ 
                        background: '#e9ecef', 
                        padding: '4px 10px', 
                        borderRadius: '12px',
                        marginRight: '12px',
                        fontWeight: '500'
                      }}>
                        #{source.category}
                      </span>
                      Last checked: {formatDate(source.last_checked)}
                    </div>
                    <div style={{ fontSize: '0.9rem', wordBreak: 'break-all', color: '#495057' }}>
                      <a href={source.url} target="_blank" rel="noopener noreferrer" style={{ color: '#007bff', textDecoration: 'none' }}>
                        {source.url}
                      </a>
                    </div>
                  </div>
                  
                  <div style={{ textAlign: 'right', minWidth: '120px' }}>
                    <div style={{ 
                      fontSize: '1rem',
                      fontWeight: 'bold',
                      color: getSuccessRateColor(source.success_rate),
                      marginBottom: '8px'
                    }}>
                      {getSuccessRateText(source.success_rate)} success
                    </div>
                    <div style={{ 
                      fontSize: '0.9rem', 
                      color: '#6c757d',
                      marginBottom: '12px',
                      fontWeight: '500'
                    }}>
                      {source.active ? '✓ Active' : '✗ Inactive'}
                    </div>
                    <button
                      onClick={() => confirmRemoveSource(source)}
                      style={{
                        background: '#dc3545',
                        color: 'white',
                        border: 'none',
                        padding: '6px 12px',
                        borderRadius: '4px',
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                        transition: 'background-color 0.2s',
                        fontWeight: '500'
                      }}
                      onMouseEnter={(e) => e.target.style.background = '#c82333'}
                      onMouseLeave={(e) => e.target.style.background = '#dc3545'}
                    >
                      🗑️ Remove
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Remove Confirmation Dialog */}
      {showRemoveConfirm && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            background: 'white',
            borderRadius: '8px',
            padding: '24px',
            maxWidth: '500px',
            width: '90%',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)'
          }}>
            <h3 style={{ margin: '0 0 16px 0', color: '#dc3545' }}>
              ⚠️ Remove Source
            </h3>
            <p style={{ margin: '0 0 16px 0', lineHeight: '1.5' }}>
              Are you sure you want to remove <strong>"{showRemoveConfirm.name}"</strong>?
            </p>
            <div style={{
              padding: '12px',
              background: '#fff3cd',
              border: '1px solid #ffeaa7',
              borderRadius: '4px',
              marginBottom: '20px',
              fontSize: '0.9rem'
            }}>
              <strong>Warning:</strong> This will permanently delete:
              <ul style={{ margin: '8px 0 0 0', paddingLeft: '20px' }}>
                <li>The RSS source configuration</li>
                <li>All articles from this source</li>
                <li>Any selected/edited articles from this source</li>
              </ul>
              This action cannot be undone.
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={cancelRemoveSource}
                disabled={isRemoving}
                style={{
                  padding: '8px 16px',
                  border: '1px solid #6c757d',
                  background: 'white',
                  color: '#6c757d',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '0.9rem'
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleRemoveSource(showRemoveConfirm.id, showRemoveConfirm.name)}
                disabled={isRemoving}
                style={{
                  padding: '8px 16px',
                  border: 'none',
                  background: '#dc3545',
                  color: 'white',
                  borderRadius: '4px',
                  cursor: isRemoving ? 'not-allowed' : 'pointer',
                  fontSize: '0.9rem',
                  opacity: isRemoving ? 0.6 : 1
                }}
              >
                {isRemoving ? 'Removing...' : 'Yes, Remove Source'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h3>Common RSS Feed URLs</h3>
        <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
          <p><strong>Finding RSS feeds:</strong></p>
          <ul>
            <li>Look for RSS/Feed icons on websites</li>
            <li>Try adding <code>/rss</code>, <code>/feed</code>, or <code>/rss.xml</code> to the end of URLs</li>
            <li>Check the website's footer for RSS links</li>
            <li>Use browser extensions like "RSS Subscription Extension"</li>
          </ul>
          
          <p><strong>Examples:</strong></p>
          <ul>
            <li>CNN: <code>https://rss.cnn.com/rss/edition.rss</code></li>
            <li>NPR: <code>https://feeds.npr.org/1001/rss.xml</code></li>
            <li>Reuters: <code>https://feeds.reuters.com/reuters/topNews</code></li>
            <li>AP News: <code>https://feeds.apnews.com/rss/apf-topnews</code></li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default SourceManager;