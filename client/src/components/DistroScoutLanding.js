import React, { useState, useEffect } from 'react';
import config from '../config';

function DistroScoutLanding({ sources = [], onArticlesSelected, onCheckNow, onStopChecking, isCheckingFeeds }) {
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
  const [storySearch, setStorySearch] = useState('');
  const [carouselIndex, setCarouselIndex] = useState(0);

  useEffect(() => {
    fetchArticles();
    fetchCategories();
    fetchLastChecked();
  }, [timeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    applyFiltersAndSort();
  }, [articles, selectedCategory, sortOrder, storySearch]); // eslint-disable-line react-hooks/exhaustive-deps

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

    // Apply search filter
    if (storySearch.trim()) {
      const q = storySearch.trim().toLowerCase();
      filtered = filtered.filter(
        (a) =>
          (a.title && a.title.toLowerCase().includes(q)) ||
          (a.preview && a.preview.toLowerCase().includes(q)) ||
          (a.source_name && a.source_name.toLowerCase().includes(q)) ||
          (a.source && String(a.source).toLowerCase().includes(q))
      );
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

  const displaySources = sources.slice(0, 8);
  const carouselPrev = () => setCarouselIndex((i) => Math.max(0, i - 1));
  const carouselNext = () => setCarouselIndex((i) => Math.min(displaySources.length - 1, i + 1));

  return (
    <div className="distro-scoopstream-landing">
      {/* Toolbar: time range + check now */}
      <div className="distro-toolbar">
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
        </div>
        <div className="distro-toolbar-actions">
          <button
            onClick={handleCheckNow}
            disabled={isRefreshing || isCheckingFeeds}
            className="distro-btn-refresh"
          >
            {isRefreshing || isCheckingFeeds ? 'Checking…' : 'Check Now'}
          </button>
          {(isRefreshing || isCheckingFeeds) && onStopChecking && (
            <button onClick={onStopChecking} className="distro-btn-stop">Stop</button>
          )}
          {lastChecked && !isRefreshing && !isCheckingFeeds && (
            <span className="distro-last-checked">Last checked {formatLastChecked(lastChecked)}</span>
          )}
        </div>
      </div>

      {/* CAROUSEL */}
      <section className="distro-carousel-section">
        <div className="distro-carousel-header">
          <h2 className="distro-section-title">
            <span className="distro-section-icon" aria-hidden>⚡</span>
            CAROUSEL
          </h2>
          {displaySources.length > 0 && (
            <>
              <div className="distro-carousel-dots">
                {displaySources.map((_, i) => (
                  <span
                    key={i}
                    className={`distro-carousel-dot ${i === carouselIndex ? 'active' : ''}`}
                    aria-hidden
                  />
                ))}
              </div>
              <div className="distro-carousel-nav">
                <button type="button" className="distro-carousel-arrow" onClick={carouselPrev} aria-label="Previous">←</button>
                <button type="button" className="distro-carousel-arrow" onClick={carouselNext} aria-label="Next">→</button>
              </div>
            </>
          )}
        </div>
        <div className="distro-carousel-track">
          {displaySources.length === 0 ? (
            <div className="distro-carousel-card distro-carousel-card-placeholder">
              <div className="distro-carousel-card-icon">D</div>
              <div className="distro-carousel-card-name">No sources yet</div>
              <div className="distro-carousel-card-meta">Add sources in the Sources tab</div>
            </div>
          ) : (
            displaySources.map((src, i) => (
              <div key={src.id || i} className="distro-carousel-card">
                <div className="distro-carousel-card-icon">
                  {(src.name || src.feed_name || 'S').charAt(0).toUpperCase()}
                </div>
                <div className="distro-carousel-card-name">{src.name || src.feed_name || 'Unnamed'}</div>
                <div className="distro-carousel-card-meta">
                  Last updated: {src.last_checked ? formatDate(src.last_checked) : '—'}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* SCROLL */}
      <section className="distro-scroll-section">
        <div className="distro-scroll-header">
          <h2 className="distro-section-title">
            <span className="distro-section-icon distro-section-icon-scroll" aria-hidden>≡</span>
            SCROLL
          </h2>
          <span className="distro-stories-badge">{filteredArticles.length} stories</span>
        </div>
        <div className="distro-scroll-actions">
          <button type="button" className="distro-btn-personalize">→ SIGN IN TO PERSONALIZE</button>
          <span className="distro-scroll-stories-label">STORIES</span>
        </div>
        <div className="distro-scroll-controls">
          <input
            type="text"
            placeholder="Search stories..."
            value={storySearch}
            onChange={(e) => setStorySearch(e.target.value)}
            className="distro-search-stories"
            aria-label="Search stories"
          />
          <div className="distro-scroll-toolbar">
            <select
              id="category-filter"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="distro-select"
            >
              <option value="all">All Categories</option>
              {categories.map((category) => (
                <option key={category.id} value={category.name}>{category.name}</option>
              ))}
            </select>
            <select
              id="sort-order"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              className="distro-select"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
            <button onClick={handleSelectAll} className="distro-btn-select-all">
              {selectedArticles.length === filteredArticles.length && filteredArticles.length > 0 ? 'Deselect All' : 'Select All'}
            </button>
          </div>
        </div>

        <div className="distro-articles-list">
          {filteredArticles.length === 0 ? (
            <div className="distro-no-articles">
              <p>No articles found. Try adding more sources or check back later.</p>
            </div>
          ) : (
            filteredArticles.map((article) => (
              <article
                key={article.id}
                className={`distro-story-card ${selectedArticles.includes(article.id) ? 'selected' : ''}`}
              >
                <button
                  type="button"
                  onClick={() => handleSelectArticle(article.id)}
                  className="distro-story-select-wrap"
                  aria-pressed={selectedArticles.includes(article.id)}
                >
                  <span className="distro-story-icon">
                    {(article.source_name || article.source || 'D').toString().charAt(0).toUpperCase()}
                  </span>
                </button>
                <div className="distro-story-body">
                  <div className="distro-story-source">{article.source_name || article.source || 'Unknown'}</div>
                  <h3 className="distro-story-title">{article.title}</h3>
                  {(article.preview && article.preview !== 'No preview available' && article.preview !== '9' && article.preview !== '9...') && (
                    <p className="distro-story-desc">{article.preview}</p>
                  )}
                  <div className="distro-story-meta">
                    <span className="distro-story-time">{formatDate(article.pub_date)}</span>
                  </div>
                </div>
                <a
                  href={article.more_info_url || article.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="distro-story-read-more"
                  aria-label="Read more"
                >
                  →
                </a>
              </article>
            ))
          )}
        </div>

        <div className="distro-landing-footer">
          <form onSubmit={handleAddUrl} className="add-url-form">
            <input
              id="newUrl"
              type="url"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="Enter a URL to add to the list"
              className="distro-url-input"
            />
            <button type="submit" className="distro-btn-add-url">Add URL</button>
          </form>
          <button
            onClick={handleGenerateSummaries}
            disabled={selectedArticles.length === 0 || isGenerating}
            className="distro-btn-generate"
          >
            {isGenerating ? 'Generating…' : `Generate Summaries (${selectedArticles.length})`}
          </button>
        </div>
      </section>
    </div>
  );
}

export default DistroScoutLanding;
