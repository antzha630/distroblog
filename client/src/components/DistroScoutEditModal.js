import React, { useState, useEffect } from 'react';

function DistroScoutEditModal({ article, isOpen, onClose, onSave }) {
  const [editedArticle, setEditedArticle] = useState({
    title: '',
    url: '',
    content: ''
  });

  useEffect(() => {
    if (article) {
      setEditedArticle({
        title: article.title || '',
        url: article.more_info_url || article.link || '',
        content: article.content || article.preview || ''
      });
    }
  }, [article]);

  const handleSave = () => {
    if (onSave) {
      onSave({
        ...article,
        title: editedArticle.title,
        more_info_url: editedArticle.url,
        link: editedArticle.url,
        content: editedArticle.content,
        preview: editedArticle.content.substring(0, 200) + '...'
      });
    }
    onClose();
  };

  const handleCancel = () => {
    onClose();
  };

  if (!isOpen || !article) {
    return null;
  }

  const formatDate = (dateString) => {
    if (!dateString) return 'Date unavailable';
    
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    });
  };

  return (
    <div className="modal-overlay">
      <div className="edit-modal">
        <div className="modal-header">
          <h3>Edit Article</h3>
        </div>

        <div className="modal-content">
          {/* Headline Field */}
          <div className="form-group">
            <label htmlFor="headline">Headline:</label>
            <input
              id="headline"
              type="text"
              value={editedArticle.title}
              onChange={(e) => setEditedArticle(prev => ({ ...prev, title: e.target.value }))}
              className="headline-input"
              placeholder="Enter article headline..."
            />
          </div>

          {/* Metadata */}
          <div className="article-metadata">
            <span className="source-info">
              {article.source_name || article.source} • {formatDate(article.pub_date || article.created_at)}
            </span>
          </div>

          {/* URL Field */}
          <div className="form-group">
            <label htmlFor="url">URL:</label>
            <input
              id="url"
              type="url"
              value={editedArticle.url}
              onChange={(e) => setEditedArticle(prev => ({ ...prev, url: e.target.value }))}
              className="url-input"
              placeholder="Enter article URL..."
            />
          </div>

          {/* Body Text Area */}
          <div className="form-group">
            <label htmlFor="content">Content:</label>
            <textarea
              id="content"
              value={editedArticle.content}
              onChange={(e) => setEditedArticle(prev => ({ ...prev, content: e.target.value }))}
              className="content-textarea"
              placeholder="Enter article content..."
              rows={10}
            />
          </div>
        </div>

        <div className="modal-actions">
          <button onClick={handleCancel} className="cancel-btn">
            Cancel
          </button>
          <button onClick={handleSave} className="save-btn">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default DistroScoutEditModal;





