import React, { useState, useEffect } from 'react';
import config from '../config';

function DistroScoutEditSend({ articles, onBack, onEditArticle, onRemoveArticle, onSendToDistro }) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [telegramSending, setTelegramSending] = useState({});
  const [sentArticles, setSentArticles] = useState([]);
  const [loadingSent, setLoadingSent] = useState(true);
  const [localArticles, setLocalArticles] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ title: '', url: '', content: '' });

  useEffect(() => {
    fetchSentArticles();
  }, []);

  useEffect(() => {
    setLocalArticles(articles || []);
  }, [articles]);

  const fetchSentArticles = async () => {
    try {
      setLoadingSent(true);
      const response = await fetch(`${config.API_BASE_URL}/api/articles/sent`);
      if (response.ok) {
        const data = await response.json();
        setSentArticles(data);
      } else {
        console.error('Failed to fetch sent articles');
      }
    } catch (error) {
      console.error('Error fetching sent articles:', error);
    } finally {
      setLoadingSent(false);
    }
  };

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
    setIsGenerating(true);
    try {
      if (onSendToDistro) {
        await onSendToDistro(localArticles);
        // Refresh sent articles after sending
        await fetchSentArticles();
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
      } else {
        alert(`❌ Failed to send to Telegram: ${result.error || 'Unknown error'}`);
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
                  className="send-btn"
                  disabled={isGenerating || editingId === article.id}
                >
                  {isGenerating ? 'Sending...' : 'Send to Distro'}
                </button>
                
                <button 
                  onClick={() => handleSendToTelegram(article.id)}
                  className="telegram-btn"
                  disabled={telegramSending[article.id] || editingId === article.id}
                >
                  {telegramSending[article.id] ? 'Sending...' : 'Send to Telegram'}
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

      {/* Already Sent Articles */}
      <div className="sent-articles-container">
        <h2 className="section-title">Already Sent</h2>
        {loadingSent ? (
          <div className="loading">Loading sent articles...</div>
        ) : sentArticles.length === 0 ? (
          <div className="no-articles">
            <p>No articles have been sent yet.</p>
          </div>
        ) : (
          sentArticles.map(article => (
            <div key={article.id} className="article-card sent-article">
              <div className="article-content">
                <div className="article-source">{article.source_name || article.source}</div>
                
                <h3 className="article-title">{article.title}</h3>
                
                <div className="article-date">{formatDate(article.pub_date || article.created_at)}</div>
                
                <div className="article-summary">
                  {article.ai_summary || article.publisher_description || article.preview || article.content || 'No summary available'}
                </div>
                
                {article.link && (
                  <a href={article.link} target="_blank" rel="noopener noreferrer" className="article-link">
                    {article.link}
                  </a>
                )}
              </div>

              <div className="article-actions">
                <button 
                  onClick={() => handleRemove(article.id)}
                  className="remove-btn"
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