import React, { useState, useEffect, useRef } from 'react';
import config from '../config';

function DistroScoutEditSend({ articles, onBack, onEditArticle, onRemoveArticle, onSendToDistro, onArticleStatusChange }) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [telegramSending, setTelegramSending] = useState({});
  const [localArticles, setLocalArticles] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ title: '', url: '', content: '' });
  // Use a ref to track status changes so we can preserve them across prop updates
  const statusMapRef = useRef(new Map());

  useEffect(() => {
    // Merge articles with local state to preserve status changes
    if (!articles || articles.length === 0) {
      setLocalArticles([]);
      statusMapRef.current.clear();
      return;
    }
    
    // Merge new articles with preserved status from ref
    const mergedArticles = articles.map(article => {
      // Check if we have a preserved 'sent' status for this article
      const preservedStatus = statusMapRef.current.get(article.id);
      // Use preserved 'sent' status if it exists, otherwise use status from new articles or default to 'new'
      const status = (preservedStatus === 'sent') ? 'sent' : (article.status || 'new');
      return {
        ...article,
        status
      };
    });
    
    setLocalArticles(mergedArticles);
  }, [articles]);

  const handleEditSummary = (article) => {
    setEditingId(article.id);
    setEditForm({
      title: article.title || '',
      url: article.link || article.more_info_url || '',
      content: article.ai_summary || article.publisher_description || article.preview || article.content || ''
    });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditForm({ title: '', url: '', content: '' });
  };

  const handleSaveEdit = async (articleId) => {
    try {
      await fetch(`${config.API_BASE_URL}/api/articles/${articleId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editForm.title,
          content: editForm.content,
          preview: editForm.content ? `${editForm.content.substring(0, 200)}${editForm.content.length > 200 ? '...' : ''}` : ''
        })
      });

      // Optimistically update local list
      setLocalArticles(prev => prev.map(a => a.id === articleId ? {
        ...a,
        title: editForm.title,
        content: editForm.content,
        ai_summary: editForm.content,
        publisher_description: editForm.content,
        preview: editForm.content ? `${editForm.content.substring(0, 200)}${editForm.content.length > 200 ? '...' : ''}` : '',
        link: editForm.url || a.link
      } : a));

      setEditingId(null);
    } catch (e) {
      console.error('Failed to save edit', e);
      alert('Failed to save changes. Please try again.');
    }
  };

  const handleRemove = (articleId) => {
    if (onRemoveArticle) {
      onRemoveArticle(articleId);
    }
  };

  const handleSendToDistro = async () => {
    // Show confirmation dialog
    if (!window.confirm('Are you sure you want to send to Distro?')) {
      return; // User cancelled
    }
    
    setIsGenerating(true);
    try {
      if (onSendToDistro) {
        await onSendToDistro(localArticles);
        // Update local articles status to 'sent'
        setLocalArticles(prev => prev.map(a => ({ ...a, status: 'sent' })));
      }
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSendToTelegram = async (articleId) => {
    setTelegramSending(prev => ({ ...prev, [articleId]: true }));
    try {
      const response = await fetch(`${config.API_BASE_URL}/api/articles/send-telegram`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ articleId }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to send to Telegram');
      }

      const result = await response.json();
      
      if (result.success) {
        alert('✅ Article sent to Telegram successfully!');
        // Update status map ref to preserve 'sent' status across prop updates
        statusMapRef.current.set(articleId, 'sent');
        // Update local article status to 'sent'
        setLocalArticles(prev => prev.map(a => 
          a.id === articleId ? { ...a, status: 'sent' } : a
        ));
        // Notify parent component of status change
        if (onArticleStatusChange) {
          onArticleStatusChange(articleId, 'sent');
        }
      } else {
        // Check for top-level error or nested Telegram error
        const errorMessage = result.error || result.telegram?.error || 'Unknown error';
        alert(`❌ Failed to send to Telegram: ${errorMessage}`);
      }
    } catch (error) {
      console.error('Error sending to Telegram:', error);
      alert(`❌ Failed to send to Telegram: ${error.message || 'Please try again.'}`);
    } finally {
      setTelegramSending(prev => ({ ...prev, [articleId]: false }));
    }
  };


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
    <div className="distro-scoopstream-edit-send">
      {/* Header */}
      <div className="edit-send-header">
        <div className="header-left">
          <h1>Distro Scoopstream - Edit/Send Posts</h1>
        </div>
        <button onClick={onBack} className="back-btn">
          Back
        </button>
      </div>

      {/* Current Articles List */}
      <div className="articles-container">
        <h2 className="section-title">Articles to Review</h2>
        {localArticles.length === 0 ? (
          <div className="no-articles">
            <p>No articles selected for editing.</p>
          </div>
        ) : (
          localArticles.map(article => (
            <div key={article.id} className="article-card">
              <div className="article-content">
                <div className="article-source">{article.source_name || article.source}</div>
                
                {editingId === article.id ? (
                  <input
                    type="text"
                    className="headline-input"
                    value={editForm.title}
                    onChange={(e) => setEditForm(prev => ({ ...prev, title: e.target.value }))}
                    placeholder="Headline"
                  />
                ) : (
                  <h3 className="article-title">{article.title}</h3>
                )}
                
                <div className="article-date">{formatDate(article.pub_date || article.created_at)}</div>
                
                {editingId === article.id ? (
                  <textarea
                    className="content-textarea"
                    rows={8}
                    value={editForm.content}
                    onChange={(e) => setEditForm(prev => ({ ...prev, content: e.target.value }))}
                    placeholder="Edit summary/content"
                  />
                ) : (
                  <div className="article-summary">
                    {article.ai_summary || article.publisher_description || article.preview || article.content || 'No summary available'}
                  </div>
                )}
                
                {editingId === article.id ? (
                  <input
                    type="url"
                    className="url-input"
                    value={editForm.url}
                    onChange={(e) => setEditForm(prev => ({ ...prev, url: e.target.value }))}
                    placeholder="URL"
                  />
                ) : (
                  article.link && (
                    <a href={article.link} target="_blank" rel="noopener noreferrer" className="article-link">
                      {article.link}
                    </a>
                  )
                )}
              </div>

              <div className="article-actions">
                {editingId === article.id ? (
                  <>
                    <button onClick={() => handleSaveEdit(article.id)} className="send-btn">Save</button>
                    <button onClick={handleCancelEdit} className="remove-btn">Cancel</button>
                  </>
                ) : (
                  <button 
                    onClick={() => handleEditSummary(article)}
                    className="edit-btn"
                  >
                    Edit Summary
                  </button>
                )}
                
                <button 
                  onClick={() => handleSendToDistro()}
                  className={`send-btn ${article.status === 'sent' ? 'already-sent' : ''}`}
                  disabled={isGenerating || editingId === article.id || article.status === 'sent'}
                >
                  {isGenerating ? 'Sending...' : article.status === 'sent' ? 'Already Sent to Distro' : 'Send to Distro'}
                </button>
                
                <button 
                  onClick={() => handleSendToTelegram(article.id)}
                  className={`telegram-btn ${article.status === 'sent' ? 'already-sent' : ''}`}
                  disabled={telegramSending[article.id] || editingId === article.id || article.status === 'sent'}
                >
                  {telegramSending[article.id] ? 'Sending...' : article.status === 'sent' ? 'Already Sent to Telegram' : 'Send to Telegram'}
                </button>
                
                <button 
                  onClick={() => handleRemove(article.id)}
                  className="remove-btn"
                  disabled={editingId === article.id}
                >
                  Remove
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Bulk Actions */}
      {localArticles.length > 0 && (
        <div className="bulk-actions">
          <button 
            onClick={handleSendToDistro}
            className="bulk-send-btn"
            disabled={isGenerating}
          >
            {isGenerating ? 'Sending All...' : `Send All to Distro (${localArticles.length})`}
          </button>
        </div>
      )}
    </div>
  );
}

export default DistroScoutEditSend;