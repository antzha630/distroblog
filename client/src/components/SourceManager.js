import React, { useState, useEffect, useRef } from 'react';
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
  // Multi-step workflow state
  const [feedCheckResult, setFeedCheckResult] = useState(null);
  const [isCheckingFeed, setIsCheckingFeed] = useState(false);
  const [isSettingUpScraping, setIsSettingUpScraping] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [reScrapingSource, setReScrapingSource] = useState(null);
  const [categories, setCategories] = useState([]);
  const [showCategorySuggestions, setShowCategorySuggestions] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [newCategory, setNewCategory] = useState('');
  const abortControllerRef = useRef(null);

  useEffect(() => {
    fetchSources();
    fetchCategories();

    // Cleanup: abort any pending requests when component unmounts
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
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

  // Step 1: Check for RSS feed
  const handleCheckFeed = async (e) => {
    e.preventDefault();
    setIsCheckingFeed(true);
    setValidationError('');
    setFeedCheckResult(null);

    try {
      const response = await axios.post('/api/sources/check-feed', {
        url: newSource.url.trim()
      });

      setFeedCheckResult(response.data);

      if (response.data.hasFeed) {
        // RSS feed found - add it directly
        await handleAddRSSSource(response.data.feedUrl);
      }
      // If no feed found, show the scraping option (handled in UI)
    } catch (error) {
      console.error('Error checking feed:', error);
      // If check-feed fails, assume no feed and show scraping option
      setFeedCheckResult({
        success: true,
        hasFeed: false,
        message: "We did not find an RSS feed for this source. Would you like us to proceed with setting up a scraping for this source?"
      });
    } finally {
      setIsCheckingFeed(false);
    }
  };

  // Add RSS source (when feed is found)
  const handleAddRSSSource = async (feedUrl) => {
    setIsValidating(true);
    setValidationError('');

    try {
      const response = await axios.post('/api/sources', {
        url: newSource.url.trim(),
        name: newSource.name.trim(),
        category: newSource.category.trim() || '',
        feedUrl: feedUrl
      });

      // Show success message
      alert(response.data.message || "OK, you're all set!");

      // Refresh sources list and categories
      await fetchSources();
      await fetchCategories();

      // Notify parent component
      if (onSourceAdded) {
        onSourceAdded();
      }

      // Reset form
      setNewSource({ url: '', name: '', category: '' });
      setShowAddForm(false);
      setFeedCheckResult(null);
    } catch (error) {
      setValidationError(
        error.response?.data?.error || 'Failed to add source'
      );
    } finally {
      setIsValidating(false);
    }
  };

  // Step 2: Set up scraping (when user confirms)
  const handleSetupScraping = async () => {
    setIsSettingUpScraping(true);
    setValidationError('');

    // Create AbortController for this request
    abortControllerRef.current = new AbortController();

    try {
      const response = await axios.post('/api/sources/setup-scraping', {
        url: newSource.url.trim(),
        name: newSource.name.trim(),
        category: newSource.category.trim() || ''
      }, {
        signal: abortControllerRef.current.signal
      });

      // Show success message
      alert(response.data.message || "OK, you're all set!");

      // Refresh sources list and categories
      await fetchSources();
      await fetchCategories();

      // Notify parent component
      if (onSourceAdded) {
        onSourceAdded();
      }

      // Reset form
      setNewSource({ url: '', name: '', category: '' });
      setShowAddForm(false);
      setFeedCheckResult(null);
    } catch (error) {
      // Don't show error if request was aborted
      if (axios.isCancel(error) || error.name === 'AbortError' || error.code === 'ERR_CANCELED') {
        setValidationError('Scraping setup was stopped.');
        return;
      }

      const errorData = error.response?.data || {};
      const errorMsg = errorData.error || 'Failed to set up scraping';
      const errorDetails = errorData.errorDetails || null;
      
      // Show detailed error message
      const fullErrorMsg = errorDetails 
        ? `${errorMsg}\n\n${errorDetails}`
        : errorMsg;
      
      // Clear the feed check result so we don't show "proceed with scraping" after a failure
      setFeedCheckResult(null);
      setValidationError(fullErrorMsg);
      alert(fullErrorMsg);
    } finally {
      setIsSettingUpScraping(false);
      abortControllerRef.current = null;
    }
  };

  // Stop scraping setup (cancels the request but keeps form open)
  const handleStopScraping = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsSettingUpScraping(false);
    setValidationError('Scraping setup was stopped. You can try again or cancel to go back.');
  };

  // Cancel and reset form completely
  const handleCancel = () => {
    // Abort any pending requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setShowAddForm(false);
    setNewSource({ url: '', name: '', category: '' });
    setFeedCheckResult(null);
    setValidationError('');
    setIsCheckingFeed(false);
    setIsSettingUpScraping(false);
    abortControllerRef.current = null;
  };

  // Cancel scraping setup (just clears the scraping state, keeps form open)
  const handleCancelScraping = () => {
    setFeedCheckResult(null);
    setValidationError('');
  };

  const handleReScrapeSource = async (sourceId, sourceName) => {
    if (!window.confirm(`Re-scrape "${sourceName}"? This will update existing articles with improved titles and dates. This may take a minute.`)) {
      return;
    }
    
    setReScrapingSource(sourceId);
    
    try {
      const response = await axios.post(`/api/sources/${sourceId}/re-scrape`);
      
      alert(`Re-scraping complete!\n\nUpdated ${response.data.articles_updated} articles with improved titles/dates.`);
      
      // Refresh sources list
      await fetchSources();
    } catch (error) {
      console.error('Error re-scraping source:', error);
      alert('Failed to re-scrape source: ' + (error.response?.data?.error || error.message));
    } finally {
      setReScrapingSource(null);
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

  const getScrapingHealthText = (source) => {
    if (source.monitoring_type !== 'SCRAPING') return null;
    
    if (!source.scraping_result) {
      return 'Not checked yet';
    }
    
    const result = source.scraping_result;
    if (result.success && result.articlesAfterFilter > 0) {
      return `✓ ${result.articlesAfterFilter} article${result.articlesAfterFilter !== 1 ? 's' : ''} found`;
    } else if (result.articlesFound > 0 && result.articlesAfterFilter === 0) {
      return `⚠️ ${result.articlesFound} external article${result.articlesFound !== 1 ? 's' : ''} filtered`;
    } else {
      return '✗ No articles found';
    }
  };

  const getScrapingHealthColor = (source) => {
    if (source.monitoring_type !== 'SCRAPING') return null;
    
    if (!source.scraping_result) {
      return '#95a5a6'; // Gray for not checked
    }
    
    const result = source.scraping_result;
    if (result.success && result.articlesAfterFilter > 0) {
      return '#27ae60'; // Green for success
    } else if (result.articlesFound > 0 && result.articlesAfterFilter === 0) {
      return '#f39c12'; // Orange for filtered
    } else {
      return '#e74c3c'; // Red for failure
    }
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
          {!showAddForm && (
          <button 
            className="btn btn-primary"
              onClick={() => {
                // Clear any stale state when opening the form
                setNewSource({ url: '', name: '', category: '' });
                setFeedCheckResult(null);
                setValidationError('');
                setIsCheckingFeed(false);
                setIsSettingUpScraping(false);
                setShowAddForm(true);
              }}
            style={{
              padding: '10px 20px',
              fontSize: '1rem',
              fontWeight: '500'
            }}
          >
              + Add Source
          </button>
          )}
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
            <form onSubmit={handleCheckFeed}>
              <div className="form-group">
                <label className="form-label">Website URL *</label>
                <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: '8px' }}>
                  💡 Tip: Enter the blog URL (e.g., https://example.com/blog) for better results
                </div>
                  <input
                    type="url"
                    className="form-input"
                    value={newSource.url}
                    onChange={(e) => setNewSource({ ...newSource, url: e.target.value })}
                    placeholder="https://example.com/blog"
                    required
                />
                <div style={{ fontSize: '0.8rem', color: '#6c757d', marginTop: '4px' }}>
                  Enter a website URL and click "Check for RSS Feed" below to see if it has an RSS feed or needs scraping.
                </div>
              </div>


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
                  padding: '16px', 
                  background: '#fee', 
                  border: '1px solid #fcc',
                  borderRadius: '4px', 
                  color: '#c53030',
                  marginBottom: '16px'
                }}>
                  <div style={{ fontWeight: '500', marginBottom: '8px' }}>
                    ⚠️ {validationError}
                  </div>
                  <div style={{ fontSize: '0.9rem', color: '#666', marginTop: '8px' }}>
                    You can try checking for an RSS feed again, or verify the URL is correct.
                  </div>
                </div>
              )}

              {/* Show scraping option if no RSS feed found */}
              {feedCheckResult && !feedCheckResult.hasFeed && (
                <div style={{ 
                  padding: '16px', 
                  background: '#fff3cd', 
                  border: '1px solid #ffc107',
                  borderRadius: '4px', 
                  marginBottom: '16px'
                }}>
                  <div style={{ marginBottom: '12px', fontWeight: '500' }}>
                    {feedCheckResult.message}
                  </div>
                  {!isSettingUpScraping && (
                    <div style={{ 
                      fontSize: '0.85rem', 
                      color: '#856404', 
                      marginBottom: '12px',
                      fontStyle: 'italic'
                    }}>
                      ⏱️ Note: Setting up scraping may take a while depending on the website.
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    {!isSettingUpScraping ? (
                      <>
                    <button 
                      type="button"
                      className="btn btn-primary"
                      onClick={handleSetupScraping}
                        >
                          Yes, proceed with scraping
                        </button>
                        <button 
                          type="button"
                          className="btn btn-secondary"
                          onClick={handleCancelScraping}
                    >
                          Cancel
                        </button>
                      </>
                    ) : (
                        <>
                        <button 
                          type="button"
                          className="btn btn-primary"
                          disabled
                          style={{ opacity: 0.6, cursor: 'not-allowed' }}
                        >
                          <div className="spinner"></div>
                          Setting up scraping...
                    </button>
                    <button 
                      type="button"
                      className="btn btn-secondary"
                          onClick={handleStopScraping}
                          style={{ background: '#dc3545', borderColor: '#dc3545' }}
                    >
                          Stop
                    </button>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Only show "Check for RSS Feed" button if we haven't checked yet */}
              {!feedCheckResult && (
              <div style={{ display: 'flex', gap: '12px' }}>
                <button 
                  type="submit" 
                  className="btn btn-primary"
                  disabled={isCheckingFeed || isValidating || !newSource.url || !newSource.name}
                >
                  {isCheckingFeed ? (
                    <>
                      <div className="spinner"></div>
                      Checking for RSS feed...
                    </>
                  ) : isValidating ? (
                    <>
                      <div className="spinner"></div>
                      Adding source...
                    </>
                  ) : (
                    'Check for RSS Feed'
                  )}
                </button>
                <button 
                  type="button"
                  className="btn btn-secondary"
                    onClick={handleCancel}
                >
                  Cancel
                </button>
              </div>
              )}
              
              {/* Show Cancel button when feed check is complete (for RSS feeds found or scraping option shown) */}
              {feedCheckResult && feedCheckResult.hasFeed && (
                <div style={{ display: 'flex', gap: '12px' }}>
                  <button 
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleCancel}
                  >
                    Close
                  </button>
                </div>
              )}
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
                    {/* Show scraping health for scraping sources, article status for RSS */}
                    {source.monitoring_type === 'SCRAPING' ? (
                      <div style={{ 
                        fontSize: '0.9rem',
                        fontWeight: 'bold',
                        color: getScrapingHealthColor(source),
                        marginBottom: '8px'
                      }}>
                        {getScrapingHealthText(source)}
                      </div>
                    ) : (
                      <div style={{ 
                        fontSize: '1rem',
                        fontWeight: 'bold',
                        color: getSuccessRateColor(source.success_rate),
                        marginBottom: '8px'
                      }}>
                        {getSuccessRateText(source.success_rate)} success
                      </div>
                    )}
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
                      {source.monitoring_type === 'SCRAPING' && (
                        <button
                          onClick={() => handleReScrapeSource(source.id, source.name)}
                          disabled={reScrapingSource === source.id}
                          style={{
                            background: reScrapingSource === source.id ? '#6c757d' : '#17a2b8',
                            color: 'white',
                            border: 'none',
                            padding: '6px 12px',
                            borderRadius: '4px',
                            fontSize: '0.8rem',
                            cursor: reScrapingSource === source.id ? 'not-allowed' : 'pointer',
                            transition: 'background-color 0.2s',
                            fontWeight: '500',
                            opacity: reScrapingSource === source.id ? 0.6 : 1
                          }}
                          onMouseEnter={(e) => {
                            if (reScrapingSource !== source.id) {
                              e.target.style.background = '#138496';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (reScrapingSource !== source.id) {
                              e.target.style.background = '#17a2b8';
                            }
                          }}
                        >
                          {reScrapingSource === source.id ? '⏳ Re-scraping...' : '🔄 Re-scrape'}
                        </button>
                      )}
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