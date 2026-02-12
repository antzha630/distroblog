import React, { useState, useEffect } from 'react';
import config from '../config';

function DistroScoutLanding({ onArticlesSelected, onCheckNow, onStopChecking, isCheckingFeeds }) {
  const [articles, setArticles] = useState([]);
  const [filteredArticles, setFilteredArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedArticles, setSelectedArticles] = useState([]);
  const [error, setError] = useState(null);
  const [timeFilter, setTimeFilter] = useState('7days'); // '2days' | '7days' | 'all'
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [categories, setCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [sortOrder, setSortOrder] = useState('newest'); // 'newest' | 'oldest'
  const [lastChecked, setLastChecked] = useState(null);

  useEffect(() => {
    fetchArticles();
    fetchCategories();
    fetchLastChecked();
  }, [timeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    applyFiltersAndSort();
  }, [articles, selectedCategory, sortOrder]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchArticles = async () => {
    try {
      setLoading(true);
      const endpoint = timeFilter === '2days' ? '/api/articles/recent/2' : '/api/articles/recent/7';
      const response = await fetch(`${config.API_BASE_URL}${endpoint}`);
      if (!response.ok) {
        throw new Error('Failed to fetch articles');
      }
      const data = await response.json();
      setArticles(data);
      setError(null);
    } catch (err) {
      console.error('Error fetching articles:', err);
      setError('Failed to load articles. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const fetchCategories = async () => {
    try {
      const response = await fetch(`${config.API_BASE_URL}/api/categories`);
      if (response.ok) {
        const data = await response.json();
        setCategories(data);
      }
    } catch (err) {
      console.error('Error fetching categories:', err);
    }
  };

  const fetchLastChecked = async () => {
    try {
      const response = await fetch(`${config.API_BASE_URL}/api/monitor/last-checked`);
      if (response.ok) {
        const data = await response.json();
        setLastChecked(data.last_checked);
      }
    } catch (err) {
      console.error('Error fetching last checked time:', err);
    }
  };

  const formatLastChecked = (timestamp) => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    const now = new Date();
    const diffInHours = Math.floor((now - date) / (1000 * 60 * 60));
    
    if (diffInHours < 1) {
      return 'Just now';
    } else if (diffInHours < 24) {
      return `${diffInHours}h ago`;
    } else {
      const diffInDays = Math.floor(diffInHours / 24);
      if (diffInDays < 7) {
        return `${diffInDays}d ago`;
      } else {
        // Format as MM/DD/YY
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const year = String(date.getFullYear()).slice(-2);
        return `${month}/${day}/${year}`;
      }
    }
  };

  const applyFiltersAndSort = () => {
    let filtered = [...articles];

    // Apply category filter
    if (selectedCategory !== 'all') {
      filtered = filtered.filter(article => article.category === selectedCategory);
    }

    // Apply sort order
    filtered.sort((a, b) => {
      const dateA = new Date(a.pub_date || a.created_at);
      const dateB = new Date(b.pub_date || b.created_at);
      
      if (sortOrder === 'newest') {
        return dateB - dateA; // Newest first
      } else {
        return dateA - dateB; // Oldest first
      }
    });

    setFilteredArticles(filtered);
  };

  const handleCheckNow = async () => {
    setIsRefreshing(true);
    try {
      // Use the prop if provided, otherwise use local implementation
      if (onCheckNow) {
        await onCheckNow();
      } else {
        // Fallback: trigger immediate feed check
        const response = await fetch(`${config.API_BASE_URL}/api/monitor/trigger`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        });
        if (!response.ok) {
          throw new Error('Failed to trigger feed check');
        }
      }
      
      // Wait a moment for feeds to process, then refresh articles and last checked time
      setTimeout(async () => {
        await fetchArticles();
        await fetchLastChecked();
        setIsRefreshing(false);
      }, 2000);
    } catch (error) {
      console.error('Error triggering check now:', error);
      setIsRefreshing(false);
    }
  };

  const handleSelectArticle = (articleId) => {
    setSelectedArticles(prev => 
      prev.includes(articleId) 
        ? prev.filter(id => id !== articleId)
        : [...prev, articleId]
    );
  };

  const handleSelectAll = () => {
    if (selectedArticles.length === filteredArticles.length && filteredArticles.length > 0) {
      setSelectedArticles([]);
    } else {
      setSelectedArticles(filteredArticles.map(article => article.id));
    }
  };

  const handleAddUrl = async (e) => {
    e.preventDefault();
    if (!newUrl.trim()) return;

    setIsGenerating(true);
    try {
      const response = await fetch(`${config.API_BASE_URL}/api/articles/fetch-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: newUrl }),
      });

      const result = await response.json();
      
      if (result.success) {
        // Add the article to the current list
        setArticles(prev => [result.article, ...prev]);
        setSelectedArticles(prev => [...prev, result.article.id]);
        setNewUrl('');
        alert('Article added successfully!');
      } else {
        alert(`Failed to add article: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error adding URL:', error);
      alert('Failed to add article. Please try again.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGenerateSummaries = async () => {
    if (selectedArticles.length === 0) {
      alert('Please select articles to generate summaries');
      return;
    }

    // Get the selected article objects
    const selectedArticleObjects = articles.filter(article => 
      selectedArticles.includes(article.id)
    );

    // Pass selected articles to parent component
    if (onArticlesSelected) {
      try {
        setIsGenerating(true);
        await onArticlesSelected(selectedArticleObjects);
      } finally {
        setIsGenerating(false);
      }
    }
  };


  const formatDate = (dateString) => {
    if (!dateString) return 'Date unavailable';

    const date = new Date(dateString);
    const now = new Date();
    const diffInHours = Math.floor((now - date) / (1000 * 60 * 60));
    
    if (diffInHours < 1) {
      return 'Just now';
    } else if (diffInHours < 24) {
      return `${diffInHours}h ago`;
    } else {
      const diffInDays = Math.floor(diffInHours / 24);
      if (diffInDays < 7) {
        return `${diffInDays}d ago`;
      } else {
        return date.toLocaleDateString();
      }
    }
  };

  if (loading) {
    return (
      <div className="distro-scoopstream-loading">
        <div className="loading-spinner"></div>
        <p>Loading articles...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="distro-scoopstream-error">
        <p className="error-message">{error}</p>
        <button onClick={fetchArticles} className="retry-btn">
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="distro-scoopstream-landing">
      {/* Header: Scoopstream title left, Past 2 Days / Past 7 Days / Check Now right */}
      <div className="distro-scoopstream-header">
        <h1 className="distro-scoopstream-title">Scoopstream</h1>
        <div className="header-controls">
          <div className="mode-toggle" role="group" aria-label="Article time range">
            <button
              type="button"
              className={`mode-btn ${timeFilter === '2days' ? 'active' : ''}`}
              onClick={() => setTimeFilter('2days')}
            >
              Past 2 Days
            </button>
            <button
              type="button"
              className={`mode-btn ${timeFilter === '7days' ? 'active' : ''}`}
              onClick={() => setTimeFilter('7days')}
            >
              Past 7 Days
            </button>
            <button
              onClick={handleCheckNow}
              disabled={isRefreshing || isCheckingFeeds}
              className="refresh-btn"
            >
              {isRefreshing || isCheckingFeeds ? '⏳ Checking...' : '🔍 Check Now'}
            </button>
          </div>
          <div className="header-controls-meta">
            {(isRefreshing || isCheckingFeeds) && onStopChecking && (
              <button onClick={onStopChecking} className="stop-btn">Stop</button>
            )}
            {lastChecked && !isRefreshing && !isCheckingFeeds && (
              <span className="last-checked-text">Last checked {formatLastChecked(lastChecked)}</span>
            )}
          </div>
        </div>
      </div>

      {/* Filter and Sort */}
      <div className="filter-sort-section">
        <div className="filter-sort-controls">
          <div className="dropdown-group">
            <label htmlFor="category-filter">Filter:</label>
            <select
              id="category-filter"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="filter-dropdown"
            >
              <option value="all">All Categories</option>
              {categories.map((category) => (
                <option key={category.id} value={category.name}>{category.name}</option>
              ))}
            </select>
          </div>
          <div className="dropdown-group">
            <label htmlFor="sort-order">Sort:</label>
            <select
              id="sort-order"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              className="sort-dropdown"
            >
              <option value="newest">Newest to Oldest</option>
              <option value="oldest">Oldest to Newest</option>
            </select>
          </div>
        </div>
        <button onClick={handleSelectAll} className="select-all-btn">
          {selectedArticles.length === filteredArticles.length && filteredArticles.length > 0 ? 'All Selected' : 'Select All'}
        </button>
      </div>

      {/* Articles List */}
      <div className="articles-list">
        {filteredArticles.length === 0 ? (
          <div className="no-articles">
            <p>No articles found. Try adding more sources or check back later.</p>
          </div>
        ) : (
          filteredArticles.map((article) => (
            <div
              key={article.id}
              className={`article-card ${selectedArticles.includes(article.id) ? 'selected' : ''}`}
            >
              <div className="distro-corners" aria-hidden>
                <span className="tl" /><span className="tr" /><span className="bl" /><span className="br" />
              </div>
              <div className="article-card-icon">
                <div className="distro-corners" aria-hidden>
                  <span className="tl" /><span className="tr" /><span className="bl" /><span className="br" />
                </div>
                <span className="article-card-icon-letter">
                  {(article.source_name || article.source || 'D').toString().charAt(0).toUpperCase()}
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleSelectArticle(article.id)}
                className={`select-btn ${selectedArticles.includes(article.id) ? 'selected' : ''}`}
              >
                {selectedArticles.includes(article.id) ? 'Selected' : 'Select'}
              </button>
              <a
                href={article.more_info_url || article.link}
                target="_blank"
                rel="noopener noreferrer"
                className="article-card-arrow"
                aria-label="Read more"
              >
                →
              </a>
              <div className="article-content">
                <div className={`article-source ${article.is_manual ? 'manual-url' : ''}`}>
                  {article.is_manual ? (
                    <>
                      {article.source_name || article.source}
                      <span className="manual-tag">🔗 MANUAL</span>
                    </>
                  ) : (
                    (article.source_name || article.source || '').toUpperCase()
                  )}
                </div>
                <h3 className="article-title">{article.title}</h3>
                <div className="article-date">{formatDate(article.pub_date)}</div>
                {article.preview && article.preview !== 'No preview available' && article.preview !== '9' && article.preview !== '9...' && (
                  <div className="article-preview">{article.preview}</div>
                )}
                {article.author && article.author !== 'Author Name' && (
                  <div className="article-author"><strong>Author:</strong> {article.author}</div>
                )}
                <div className="article-url">
                  <a href={article.more_info_url || article.link} target="_blank" rel="noopener noreferrer" className="article-link">
                    {article.more_info_url || article.link}
                  </a>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add URL */}
      <div className="add-url-section">
        <form onSubmit={handleAddUrl} className="add-url-form">
          <label htmlFor="newUrl">Add URL:</label>
          <input
            id="newUrl"
            type="url"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="Enter a URL to add to the list"
            className="url-input"
          />
          <button type="submit" className="add-url-btn">Add</button>
        </form>
      </div>

      {/* Generate Summaries */}
      <div className="generate-section">
        <button
          onClick={handleGenerateSummaries}
          disabled={selectedArticles.length === 0 || isGenerating}
          className="generate-btn"
        >
          {isGenerating ? 'Generating Summaries…' : `Generate Summaries (${selectedArticles.length})`}
        </button>
      </div>
    </div>
  );
}

export default DistroScoutLanding;
