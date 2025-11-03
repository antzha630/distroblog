import React, { useState, useEffect } from 'react';
import axios from 'axios';

function SourceManager({ onSourceAdded, onSourceRemoved, refreshTrigger }) {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newSource, setNewSource] = useState({
    url: '',
    name: '',
    category: ''
  });
  const [isValidating, setIsValidating] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [detectedFeeds, setDetectedFeeds] = useState([]);
  const [isDetecting, setIsDetecting] = useState(false);
  const [showDetectedFeeds, setShowDetectedFeeds] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [categories, setCategories] = useState([]);
  const [showCategorySuggestions, setShowCategorySuggestions] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [newCategory, setNewCategory] = useState('');

  useEffect(() => {
    fetchSources();
    fetchCategories();
  }, []);

  // Watch for refresh trigger from parent
  useEffect(() => {
    if (refreshTrigger) {
      fetchSources();
    }
  }, [refreshTrigger]);

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

  const fetchCategories = async () => {
    try {
      const response = await axios.get('/api/categories');
      setCategories(response.data);
    } catch (error) {
      console.error('Error fetching categories:', error);
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

      // Only show feeds that the server marked as valid
      const validFeeds = (response.data.feeds || []).filter(f => f.status === 'valid');
      setDetectedFeeds(validFeeds);
      setShowDetectedFeeds(true);

      if (validFeeds.length === 0) {
        setValidationError('No valid RSS feeds found. Try entering the direct RSS URL.');
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

  const handleCategoryChange = (e) => {
    const value = e.target.value;
    setNewSource({ ...newSource, category: value });
    setShowCategorySuggestions(value.length > 0);
  };

  const handleCategorySelect = (categoryName) => {
    setNewSource({ ...newSource, category: categoryName });
    setShowCategorySuggestions(false);
  };

  const filteredCategories = categories.filter(cat => 
    cat.name.toLowerCase().includes(newSource.category.toLowerCase())
  );

  const handlePauseSource = async (sourceId, sourceName) => {
    try {
      await axios.post(`/api/sources/${sourceId}/pause`);
      
      // Refresh sources list
      await fetchSources();
      
      console.log(`Source "${sourceName}" has been paused`);
    } catch (error) {
      console.error('Error pausing source:', error);
    }
  };

  const handleReactivateSource = async (sourceId, sourceName) => {
    try {
      await axios.post(`/api/sources/${sourceId}/reactivate`);
      
      // Refresh sources list
      await fetchSources();
      
      console.log(`Source "${sourceName}" has been reactivated`);
    } catch (error) {
      console.error('Error reactivating source:', error);
    }
  };

  const handleAddSource = async (e) => {
    e.preventDefault();
    setIsValidating(true);
    setValidationError('');

    try {
      await axios.post('/api/sources', newSource);
      
      // Refresh sources list and categories
      await fetchSources();
      await fetchCategories();
      
      // Notify parent component that source was added
      if (onSourceAdded) {
        onSourceAdded();
      }
      
      // Reset form
      setNewSource({ url: '', name: '', category: '' });
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

  const handleEditCategory = (sourceId, currentCategory) => {
    setEditingCategory(sourceId);
    setNewCategory(currentCategory || '');
  };

  const handleSaveCategory = async (sourceId) => {
    try {
      // Update the source's category in the database
      await axios.put(`/api/sources/${sourceId}/category`, {
        category: newCategory.trim()
      });
      
      // Update local state
      setSources(prev => prev.map(s => 
        s.id === sourceId ? { ...s, category: newCategory.trim() } : s
      ));
      
      setEditingCategory(null);
      setNewCategory('');
    } catch (error) {
      console.error('Error updating category:', error);
      alert('Failed to update category. Please try again.');
    }
  };

  const handleCancelEdit = () => {
    setEditingCategory(null);
    setNewCategory('');
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
          <h2 className="card-title" style={{ margin: '0 0 16px 0' }}>Sources</h2>
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
            <h3 style={{ marginTop: 0 }}>Add Source</h3>
            <form onSubmit={handleAddSource}>
              <div className="form-group">
                <label className="form-label">Website *</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="url"
                    className="form-input"
                    value={newSource.url}
                    onChange={(e) => setNewSource({ ...newSource, url: e.target.value })}
                    placeholder="https://example.com"
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
                  Enter a website URL (like https://techcrunch.com) and we'll find RSS feeds for you.
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
                <div style={{ position: 'relative' }}>
                  <input
                    type="text"
                    className="form-input"
                    value={newSource.category}
                    onChange={handleCategoryChange}
                    onFocus={() => setShowCategorySuggestions(newSource.category.length > 0)}
                    onBlur={() => setTimeout(() => setShowCategorySuggestions(false), 200)}
                    placeholder="Type a category name (e.g., Technology, Health, Politics)"
                    required
                  />
                  {showCategorySuggestions && filteredCategories.length > 0 && (
                    <div style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      right: 0,
                      background: 'white',
                      border: '1px solid #ddd',
                      borderTop: 'none',
                      borderRadius: '0 0 4px 4px',
                      maxHeight: '200px',
                      overflowY: 'auto',
                      zIndex: 1000,
                      boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                    }}>
                      {filteredCategories.map((category) => (
                        <div
                          key={category.id}
                          style={{
                            padding: '8px 12px',
                            cursor: 'pointer',
                            borderBottom: '1px solid #eee'
                          }}
                          onMouseDown={() => handleCategorySelect(category.name)}
                          onMouseEnter={(e) => e.target.style.backgroundColor = '#f5f5f5'}
                          onMouseLeave={(e) => e.target.style.backgroundColor = 'white'}
                        >
                          {category.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
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
              <div style={{ fontSize: '0.8rem', marginTop: '8px', color: '#6c757d', fontWeight: 'normal' }}>
                💡 <strong>Paused sources:</strong> Won't be checked for new articles, but can be reactivated anytime
              </div>
            </div>
            
            {sources.map(source => (
              <div key={source.id} style={{
                border: source.is_paused ? '1px solid #ffc107' : '1px solid #e9ecef',
                borderRadius: '8px',
                padding: '20px',
                marginBottom: '16px',
                background: source.is_paused ? '#fffbf0' : 'white',
                boxShadow: source.is_paused ? '0 2px 8px rgba(255,193,7,0.15)' : '0 2px 4px rgba(0,0,0,0.05)',
                opacity: source.is_paused ? 0.8 : 1
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <h3 style={{ margin: '0 0 12px 0', fontSize: '1.2rem', color: '#2c3e50' }}>
                      {source.name}
                    </h3>
                    <div style={{ fontSize: '0.9rem', color: '#6c757d', marginBottom: '12px' }}>
                      {editingCategory === source.id ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                          <input
                            type="text"
                            value={newCategory}
                            onChange={(e) => setNewCategory(e.target.value)}
                            placeholder="Enter category"
                            style={{
                              padding: '4px 8px',
                              border: '1px solid #ced4da',
                              borderRadius: '4px',
                              fontSize: '0.9rem',
                              width: '150px'
                            }}
                            onKeyPress={(e) => {
                              if (e.key === 'Enter') {
                                handleSaveCategory(source.id);
                              }
                            }}
                          />
                          <button
                            onClick={() => handleSaveCategory(source.id)}
                            style={{
                              background: '#28a745',
                              color: 'white',
                              border: 'none',
                              padding: '4px 8px',
                              borderRadius: '4px',
                              fontSize: '0.8rem',
                              cursor: 'pointer'
                            }}
                          >
                            ✓
                          </button>
                          <button
                            onClick={handleCancelEdit}
                            style={{
                              background: '#6c757d',
                              color: 'white',
                              border: 'none',
                              padding: '4px 8px',
                              borderRadius: '4px',
                              fontSize: '0.8rem',
                              cursor: 'pointer'
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <span style={{ 
                          background: '#e9ecef', 
                          padding: '4px 10px', 
                          borderRadius: '12px',
                          marginRight: '12px',
                          fontWeight: '500',
                          cursor: 'pointer',
                          display: 'inline-block'
                        }}
                        onClick={() => handleEditCategory(source.id, source.category)}
                        title="Click to edit category"
                        >
                          #{source.category || 'No category'}
                        </span>
                      )}
                      Last checked: {formatDate(source.last_checked)}
                    </div>
                    <div style={{ fontSize: '0.9rem', wordBreak: 'break-all', color: '#495057' }}>
                      <a href={source.url} target="_blank" rel="noopener noreferrer" style={{ color: '#007bff', textDecoration: 'none' }}>
                        {source.url}
                      </a>
                    </div>
                  </div>
                  
                  <div style={{ textAlign: 'right', minWidth: '140px' }}>
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
                      color: source.is_paused ? '#ffc107' : '#28a745',
                      marginBottom: '8px',
                      fontWeight: '500'
                    }}>
                      {source.is_paused ? '⏸️ Paused' : '✓ Active'}
                    </div>
                    <div style={{ 
                      fontSize: '0.8rem', 
                      color: source.monitoring_type === 'SCRAPING' ? '#ff9800' : '#007bff',
                      marginBottom: '12px',
                      fontWeight: '500',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      backgroundColor: source.monitoring_type === 'SCRAPING' ? '#fff3e0' : '#e3f2fd',
                      display: 'inline-block'
                    }}>
                      {source.monitoring_type === 'SCRAPING' ? '🌐 Scraping' : '📡 RSS Feed'}
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexDirection: 'column' }}>
                      {source.is_paused ? (
                        <button
                          onClick={() => handleReactivateSource(source.id, source.name)}
                          style={{
                            background: '#28a745',
                            color: 'white',
                            border: 'none',
                            padding: '6px 12px',
                            borderRadius: '4px',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                            transition: 'background-color 0.2s',
                            fontWeight: '500'
                          }}
                          onMouseEnter={(e) => e.target.style.background = '#218838'}
                          onMouseLeave={(e) => e.target.style.background = '#28a745'}
                        >
                          ▶️ Reactivate
                        </button>
                      ) : (
                        <button
                          onClick={() => handlePauseSource(source.id, source.name)}
                          style={{
                            background: '#ffc107',
                            color: '#212529',
                            border: 'none',
                            padding: '6px 12px',
                            borderRadius: '4px',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                            transition: 'background-color 0.2s',
                            fontWeight: '500'
                          }}
                          onMouseEnter={(e) => e.target.style.background = '#e0a800'}
                          onMouseLeave={(e) => e.target.style.background = '#ffc107'}
                        >
                          ⏸️ Pause
                        </button>
                      )}
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