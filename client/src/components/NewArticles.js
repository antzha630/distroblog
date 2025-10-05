import React, { useState, useEffect } from 'react';

function NewArticles({ onArticlesUpdated, onArticlesSelected }) {
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedArticles, setSelectedArticles] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchArticles();
  }, []);

  const fetchArticles = async () => {
    try {
      setLoading(true);
      const response = await fetch('http://localhost:3001/api/articles/new');
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

  const handleSelectArticle = (articleId) => {
    setSelectedArticles(prev => 
      prev.includes(articleId) 
        ? prev.filter(id => id !== articleId)
        : [...prev, articleId]
    );
  };

  const handleSelectAll = () => {
    if (selectedArticles.length === articles.length) {
      setSelectedArticles([]);
    } else {
      setSelectedArticles(articles.map(article => article.id));
    }
  };

  const handleProceedToEdit = () => {
    if (selectedArticles.length === 0) {
      alert('Please select articles to edit');
      return;
    }

    // Get the selected article objects
    const selectedArticleObjects = articles.filter(article => 
      selectedArticles.includes(article.id)
    );

    // Mark articles as selected in the database
    handleReviewArticles('select');
    
    // Pass selected articles to parent component
    if (onArticlesSelected) {
      onArticlesSelected(selectedArticleObjects);
    }
  };

  const handleReviewArticles = async (action) => {
    if (selectedArticles.length === 0) {
      alert(`Please select articles to ${action}`);
      return;
    }

    try {
      const response = await fetch('http://localhost:3001/api/articles/review', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          articleIds: selectedArticles,
          action: action
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to ${action} articles`);
      }

      const result = await response.json();
      console.log(result.message);
      
      // Clear selection and refresh articles
      setSelectedArticles([]);
      await fetchArticles();
      
      if (onArticlesUpdated) {
        onArticlesUpdated();
      }
    } catch (err) {
      console.error(`Error ${action}ing articles:`, err);
      alert(`Failed to ${action} articles. Please try again.`);
    }
  };


  const formatDate = (dateString, isPublicationDate = false) => {
    if (!dateString) return 'Date unavailable';
    
    const date = new Date(dateString);
    const now = new Date();
    const diffInHours = Math.floor((now - date) / (1000 * 60 * 60));
    
    if (isPublicationDate) {
      // For publication dates, show actual date
      if (diffInHours < 1) {
        return 'Published just now';
      } else if (diffInHours < 24) {
        return `Published ${diffInHours}h ago`;
      } else {
        const diffInDays = Math.floor(diffInHours / 24);
        if (diffInDays < 7) {
          return `Published ${diffInDays}d ago`;
        } else {
          return `Published ${date.toLocaleDateString()}`;
        }
      }
    } else {
      // For processing dates, show when added
      if (diffInHours < 1) {
        return 'Just now';
      } else if (diffInHours < 24) {
        return `Added ${diffInHours}h ago`;
      } else {
        const diffInDays = Math.floor(diffInHours / 24);
        return `Added ${diffInDays}d ago`;
      }
    }
  };

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner"></div>
        <p>Loading articles...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-container">
        <p className="error-message">{error}</p>
        <button onClick={fetchArticles} className="retry-btn">
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="new-articles">
      <div className="articles-header">
        <h2>New Articles ({articles.length})</h2>
        <div className="articles-actions">
          <button 
            onClick={handleSelectAll}
            className="select-all-btn"
          >
            {selectedArticles.length === articles.length ? 'Deselect All' : 'Select All'}
          </button>
          <button 
            onClick={handleProceedToEdit}
            disabled={selectedArticles.length === 0}
            className="select-btn"
          >
            Proceed to Edit ({selectedArticles.length})
          </button>
          <button 
            onClick={() => handleReviewArticles('dismiss')}
            disabled={selectedArticles.length === 0}
            className="dismiss-btn"
          >
            Dismiss ({selectedArticles.length})
          </button>
        </div>
      </div>

      {articles.length === 0 ? (
        <div className="no-articles">
          <p>No new articles found. Try adding more sources or check back later.</p>
        </div>
      ) : (
        <div className="articles-list">
          {articles.map(article => (
            <div 
              key={article.id} 
              className={`article-card ${selectedArticles.includes(article.id) ? 'selected' : ''}`}
            >
              <div className="article-header">
                <input
                  type="checkbox"
                  checked={selectedArticles.includes(article.id)}
                  onChange={() => handleSelectArticle(article.id)}
                  className="article-checkbox"
                />
                <div className="article-meta">
                  <div className="article-source-row">
                    <span className="article-source">{article.source || article.source_name}</span>
                    <span className="article-date">
                      {article.pub_date ? 
                        formatDate(article.pub_date, true) : 
                        formatDate(article.created_at, false)
                      }
                    </span>
                  </div>
                </div>
                <div className="article-badge">
                  <span className="new-badge">NEW</span>
                </div>
              </div>
              
              <div className="article-content">
                <h3 className="article-title">{article.title}</h3>
                
                {article.preview && article.preview !== "No preview available" && article.preview !== "9" && article.preview !== "9..." && (
                  <div className="article-preview">
                    <strong>Summary:</strong> {article.preview}
                  </div>
                )}
                
              </div>
              
              <div className="article-actions">
                <a 
                  href={article.more_info_url || article.link} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="article-link"
                >
                  Read Original →
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default NewArticles;
