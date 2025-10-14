import React, { useState, useEffect } from 'react';
import './App.css';
import './DistroScout.css';
import SourceManager from './components/SourceManager';
import DistroScoutLanding from './components/DistroScoutLanding';
import DistroScoutEditSend from './components/DistroScoutEditSend';
import config from './config';

function App() {
  const [activeTab, setActiveTab] = useState('distro-scout');
  const [sources, setSources] = useState([]);
  const [selectedArticles, setSelectedArticles] = useState([]);
  const [workflowStep, setWorkflowStep] = useState('review'); // 'review', 'edit', 'send'
  const [distroScoutStep, setDistroScoutStep] = useState('landing'); // 'landing', 'edit-send'
  // inline editing only; no modal state

  useEffect(() => {
    fetchSources();
  }, []);

  const fetchSources = async () => {
    try {
      const response = await fetch(`${config.API_BASE_URL}/api/sources`);
      const data = await response.json();
      setSources(data);
    } catch (error) {
      console.error('Error fetching sources:', error);
    }
  };


  const handleSourceAdded = () => {
    fetchSources();
  };

  const handleSourceRemoved = () => {
    fetchSources();
  };

  const handleArticlesUpdated = () => {
    // Articles are managed by the NewArticles component
  };

  const handleArticlesSelected = (articles) => {
    setSelectedArticles(articles);
    setWorkflowStep('edit');
  };

  const handleDistroScoutArticlesSelected = async (articles) => {
    try {
      const articleIds = articles.map(a => a.id);

      // Ask server to generate summaries for these IDs
      const resp = await fetch(`${config.API_BASE_URL}/api/articles/generate-summaries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleIds })
      });

      if (!resp.ok) throw new Error('Failed to generate summaries');

      const { results } = await resp.json();
      // Map returned summaries back onto the same selected articles
      const idToSummary = new Map(results.filter(r => r.success).map(r => [r.articleId, r.summary]));
      const withSummaries = articles.map(a => ({ ...a, ai_summary: idToSummary.get(a.id) || a.ai_summary }));

      setSelectedArticles(withSummaries);
      setDistroScoutStep('edit-send');
    } catch (e) {
      console.error('Error generating AI summaries:', e);
      setSelectedArticles(articles);
      setDistroScoutStep('edit-send');
    }
  };

  const handleBackToDistroScoutLanding = () => {
    setDistroScoutStep('landing');
    setSelectedArticles([]);
  };

  const handleEditArticle = () => {};

  const handleRemoveArticle = (articleId) => {
    setSelectedArticles(prev => prev.filter(article => article.id !== articleId));
  };

  const handleSaveEditedArticle = () => {};

  const handleSendToDistro = async (articles) => {
    try {
      const response = await fetch(`${config.API_BASE_URL}/api/articles/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          articleIds: articles.map(article => article.id),
          userInfo: {
            name: "Distro Scout User"
          }
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to send articles');
      }

      const result = await response.json();
      alert(`Successfully sent ${result.successCount} articles to Distro!`);
      
      // Reset workflow
      setDistroScoutStep('landing');
      setSelectedArticles([]);
    } catch (error) {
      console.error('Error sending articles:', error);
      alert('Failed to send articles. Please try again.');
    }
  };

  const handleEditComplete = () => {
    setWorkflowStep('send');
  };

  const handleBackToReview = () => {
    setWorkflowStep('review');
    setSelectedArticles([]);
  };

  const handleBackToEdit = () => {
    setWorkflowStep('edit');
  };

  const handleSendArticles = async () => {
    try {
      const response = await fetch(`${config.API_BASE_URL}/api/articles/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          articleIds: selectedArticles.map(article => article.id),
          userInfo: {
            name: "Author Name" // This could be made configurable
          }
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to send articles');
      }

      const result = await response.json();
      
      // Show detailed message from server
      if (result.success) {
        alert(result.message);
      } else {
        alert(`❌ ${result.message}`);
      }
      
      // Reset workflow
      setWorkflowStep('review');
      setSelectedArticles([]);
    } catch (error) {
      console.error('Error sending articles:', error);
      alert('Failed to send articles. Please try again.');
    }
  };

  const handleCheckNow = async () => {
    try {
      // Trigger immediate feed check
      const response = await fetch(`${config.API_BASE_URL}/api/monitor/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (response.ok) {
        console.log('Feed check triggered successfully');
      }
    } catch (error) {
      console.error('Error triggering feed check:', error);
    }
  };

  return (
    <div className="App">
      <header className="header">
        <div className="header-content">
          <div>
            <h1>Distro Scout</h1>
            <p className="header-stats">news monitoring tool for journalists</p>
          </div>
          <nav className="header-nav">
            <button 
              className={`nav-link ${activeTab === 'distro-scout' ? 'active' : ''}`}
              onClick={() => setActiveTab('distro-scout')}
            >
              Distro Scout
            </button>
            <button 
              className={`nav-link ${activeTab === 'sources' ? 'active' : ''}`}
              onClick={() => setActiveTab('sources')}
            >
              Sources
            </button>
            <button 
              className="nav-link check-now-btn"
              onClick={handleCheckNow}
              title="Check all sources for new articles immediately"
            >
              🔍 Check Now
            </button>
          </nav>
        </div>
      </header>

      <main className="main-content">
        {activeTab === 'distro-scout' && distroScoutStep === 'landing' && (
          <DistroScoutLanding 
            onArticlesSelected={handleDistroScoutArticlesSelected}
          />
        )}
        {activeTab === 'distro-scout' && distroScoutStep === 'edit-send' && (
          <DistroScoutEditSend 
            articles={selectedArticles}
            onBack={handleBackToDistroScoutLanding}
            onEditArticle={handleEditArticle}
            onRemoveArticle={handleRemoveArticle}
            onSendToDistro={handleSendToDistro}
          />
        )}
        {activeTab === 'sources' && (
          <SourceManager 
            sources={sources}
            onSourceAdded={handleSourceAdded}
            onSourceRemoved={handleSourceRemoved}
          />
        )}
        {activeTab === 'new' && workflowStep === 'send' && (
          <div className="send-confirmation">
            <h2>Send Articles</h2>
            <p>Ready to send {selectedArticles.length} selected articles?</p>
            <div className="send-actions">
              <button onClick={handleBackToEdit} className="back-btn">
                ← Back to Edit
              </button>
              <button onClick={handleSendArticles} className="send-btn">
                Send Articles
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Legacy modal not used for inline editing; keeping for future use but always closed */}
    </div>
  );
}

export default App;
