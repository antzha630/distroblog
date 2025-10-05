import React, { useState, useEffect } from 'react';
import axios from 'axios';

function EditArticles({ articles, onArticlesEdited, onBack }) {
  const [editedArticles, setEditedArticles] = useState([]);
  const [currentArticleIndex, setCurrentArticleIndex] = useState(0);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    // Initialize with articles data
    setEditedArticles(articles.map(article => ({
      ...article,
      edited_title: article.title,
      edited_content: article.content || article.summary,
      edited_preview: article.preview || article.summary?.substring(0, 200) + '...'
    })));
  }, [articles]);

  const currentArticle = editedArticles[currentArticleIndex];

  const handleFieldChange = (field, value) => {
    const newArticles = [...editedArticles];
    newArticles[currentArticleIndex] = {
      ...newArticles[currentArticleIndex],
      [field]: value
    };
    setEditedArticles(newArticles);
    setHasChanges(true);
  };

  const saveCurrentArticle = async () => {
    if (!currentArticle) return;

    try {
      await axios.put(`/api/articles/${currentArticle.id}`, {
        title: currentArticle.edited_title,
        content: currentArticle.edited_content,
        preview: currentArticle.edited_preview
      });
    } catch (error) {
      console.error('Error saving article:', error);
    }
  };

  const handlePrevious = async () => {
    await saveCurrentArticle();
    setCurrentArticleIndex(Math.max(0, currentArticleIndex - 1));
  };

  const handleNext = async () => {
    await saveCurrentArticle();
    setCurrentArticleIndex(Math.min(editedArticles.length - 1, currentArticleIndex + 1));
  };

  const handleBackToReview = async () => {
    try {
      // Revert articles back to 'new' status so they appear in review again
      const articleIds = editedArticles.map(article => article.id);
      await axios.post('/api/articles/revert', { articleIds });
      
      // Go back to review
      onBack();
    } catch (error) {
      console.error('Error reverting articles:', error);
      // Even if revert fails, still go back
      onBack();
    }
  };

  const handleSaveAndProceed = async () => {
    // Save current article
    await saveCurrentArticle();
    
    // Save all other articles that have been edited
    for (const article of editedArticles) {
      if (article.id !== currentArticle.id) {
        try {
          await axios.put(`/api/articles/${article.id}`, {
            title: article.edited_title,
            content: article.edited_content,
            preview: article.edited_preview
          });
        } catch (error) {
          console.error('Error saving article:', error);
        }
      }
    }

    onArticlesEdited(editedArticles);
  };

  const generatePreview = (content) => {
    if (!content) return '';
    const plainText = content.replace(/<[^>]*>/g, '');
    return plainText.length > 200 ? plainText.substring(0, 197) + '...' : plainText;
  };

  const handleAutoGeneratePreview = () => {
    const preview = generatePreview(currentArticle.edited_content);
    handleFieldChange('edited_preview', preview);
  };

  if (!currentArticle) {
    return (
      <div className="card">
        <div className="loading">Loading article editor...</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header" style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '20px'
      }}>
        <div>
          <h2 className="card-title" style={{ margin: '0 0 8px 0' }}>
            Edit Articles ({currentArticleIndex + 1} of {editedArticles.length})
          </h2>
          <div className="text-muted" style={{ fontSize: '0.9rem' }}>
            Source: {currentArticle.source_name}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: '20px' }}>
        <div className="step-indicator">
          {editedArticles.map((_, index) => (
            <div 
              key={index}
              className={`step ${index === currentArticleIndex ? 'active' : index < currentArticleIndex ? 'completed' : 'pending'}`}
            >
              Article {index + 1}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gap: '20px', gridTemplateColumns: '1fr 1fr' }}>
        {/* Original Article */}
        <div>
          <h3 style={{ marginBottom: '16px', color: '#6c757d' }}>Original</h3>
          <div style={{ padding: '16px', background: '#f8f9fa', borderRadius: '4px', height: '500px', overflow: 'auto' }}>
            <h4 style={{ margin: '0 0 12px 0' }}>{currentArticle.title}</h4>
            <div style={{ fontSize: '0.9rem', color: '#6c757d', marginBottom: '12px' }}>
              {currentArticle.source_name} • {currentArticle.pub_date ? new Date(currentArticle.pub_date + 'Z').toLocaleDateString() : 'Date unavailable'}
            </div>
            <div style={{ lineHeight: '1.5' }}>
              {currentArticle.summary || currentArticle.content}
            </div>
            <a 
              href={currentArticle.link} 
              target="_blank" 
              rel="noopener noreferrer"
              style={{ display: 'inline-block', marginTop: '12px', color: '#3498db' }}
            >
              View Original →
            </a>
          </div>
        </div>

        {/* Edited Article */}
        <div>
          <h3 style={{ marginBottom: '16px', color: '#2c3e50' }}>Your Edit</h3>
          <div style={{ height: '500px', overflow: 'auto' }}>
            <div className="form-group">
              <label className="form-label">Title</label>
              <input
                type="text"
                className="form-input"
                value={currentArticle.edited_title}
                onChange={(e) => handleFieldChange('edited_title', e.target.value)}
                placeholder="Edit the headline..."
              />
            </div>

            <div className="form-group">
              <label className="form-label">
                Content
                <span style={{ 
                  fontSize: '0.8rem', 
                  color: '#6c757d', 
                  fontWeight: 'normal',
                  marginLeft: '8px'
                }}>
                  (Full article content - can be long)
                </span>
              </label>
              <textarea
                className="form-textarea"
                value={currentArticle.edited_content}
                onChange={(e) => handleFieldChange('edited_content', e.target.value)}
                placeholder="Edit the full article content..."
                rows={8}
              />
            </div>

            <div className="form-group">
              <label className="form-label">
                Preview (for feed)
                <span style={{ 
                  fontSize: '0.8rem', 
                  color: '#6c757d', 
                  fontWeight: 'normal',
                  marginLeft: '8px'
                }}>
                  (Short snippet for social media - 150-200 chars)
                </span>
                <button 
                  type="button"
                  onClick={handleAutoGeneratePreview}
                  style={{ 
                    marginLeft: '10px', 
                    fontSize: '0.8rem', 
                    padding: '4px 8px',
                    background: '#e9ecef',
                    border: 'none',
                    borderRadius: '3px',
                    cursor: 'pointer'
                  }}
                >
                  Auto-generate
                </button>
              </label>
              <textarea
                className="form-textarea"
                value={currentArticle.edited_preview}
                onChange={(e) => handleFieldChange('edited_preview', e.target.value)}
                placeholder="Brief preview text..."
                rows={3}
              />
              <div style={{ fontSize: '0.8rem', color: '#6c757d', marginTop: '4px' }}>
                {currentArticle.edited_preview?.length || 0} characters
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="btn-group">
        <button className="btn btn-secondary" onClick={handleBackToReview}>
          ← Back to Review
        </button>
        
        <div style={{ display: 'flex', gap: '12px' }}>
          <button 
            className="btn btn-secondary"
            onClick={handlePrevious}
            disabled={currentArticleIndex === 0}
          >
            ← Previous
          </button>
          
          {currentArticleIndex < editedArticles.length - 1 ? (
            <button 
              className="btn btn-primary"
              onClick={handleNext}
            >
              Next →
            </button>
          ) : (
            <button 
              className="btn btn-success"
              onClick={handleSaveAndProceed}
            >
              Proceed to Send →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default EditArticles;