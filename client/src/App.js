import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import './App.css';
import './DistroScoopstream.css';
import SourceManager from './components/SourceManager';
import DistroScoutLanding from './components/DistroScoutLanding';
import DistroScoutEditSend from './components/DistroScoutEditSend';
import ADKWeb from './components/ADKWeb';
import config from './config';

function MainApp() {
  const location = useLocation();
  const navigate = useNavigate();
  
  // Determine active tab from URL path
  const getActiveTabFromPath = (path) => {
    if (path === '/agent-test') return 'adk-web';
    if (path === '/sources') return 'sources';
    return 'distro-scoopstream';
  };
  
  const [activeTab, setActiveTab] = useState(() => getActiveTabFromPath(location.pathname));
  const [sources, setSources] = useState([]);
  const [selectedArticles, setSelectedArticles] = useState([]);
  const [workflowStep, setWorkflowStep] = useState('review'); // 'review', 'edit', 'send'
  const [distroScoutStep, setDistroScoutStep] = useState('landing'); // 'landing', 'edit-send'
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [isCheckingFeeds, setIsCheckingFeeds] = useState(false);
  const checkTimeoutRef = useRef(null);
  // inline editing only; no modal state

  useEffect(() => {
    fetchSources();
  }, []);

  // Sync active tab with URL path changes
  useEffect(() => {
    const path = location.pathname;
    const tab = getActiveTabFromPath(path);
    if (tab !== activeTab) {
      setActiveTab(tab);
    }
  }, [location.pathname]);

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

  const handleArticleStatusChange = (articleId, status) => {
    // Update the status of the article in selectedArticles
    setSelectedArticles(prev => prev.map(article => 
      article.id === articleId ? { ...article, status } : article
    ));
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
            name: "Distro Scoopstream User"
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
    setIsCheckingFeeds(true);
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
        // Wait a moment for the feeds to process, then refresh sources
        checkTimeoutRef.current = setTimeout(() => {
          setRefreshTrigger(prev => prev + 1);
          setIsCheckingFeeds(false);
          checkTimeoutRef.current = null;
        }, 2000);
      } else {
        setIsCheckingFeeds(false);
      }
    } catch (error) {
      console.error('Error triggering feed check:', error);
      setIsCheckingFeeds(false);
    }
  };

  const handleStopChecking = () => {
    if (checkTimeoutRef.current) {
      clearTimeout(checkTimeoutRef.current);
      checkTimeoutRef.current = null;
    }
    setIsCheckingFeeds(false);
  };

  // Don't show header/nav for agent-test - it has its own full-screen UI
  const showHeaderNav = activeTab !== 'adk-web';

  return (
    <div className="App">
      {showHeaderNav && (
        <header className="header">
          <div className="header-content">
            <div>
              <h1>Distro Scoopstream</h1>
              <p className="header-stats">news monitoring tool for journalists</p>
            </div>
            <nav className="header-nav">
            {activeTab !== 'distro-scoopstream' && (
              <button 
                className="nav-link"
                onClick={() => {
                  setActiveTab('distro-scoopstream');
                  navigate('/');
                }}
              >
                Scoopstream
              </button>
            )}
            {activeTab !== 'sources' && (
              <button 
                className="nav-link"
                onClick={() => {
                  setActiveTab('sources');
                  navigate('/sources');
                }}
              >
                Sources
              </button>
            )}
            {activeTab !== 'adk-web' && (
              <button 
                className="nav-link"
                onClick={() => {
                  setActiveTab('adk-web');
                  navigate('/agent-test');
                }}
              >
                Agent Test
              </button>
            )}
          </nav>
        </div>
          </div>
        </header>
      )}

      <main className={activeTab === 'adk-web' ? 'main-content-fullscreen' : 'main-content'}>
        {activeTab === 'distro-scoopstream' && distroScoutStep === 'landing' && (
          <DistroScoutLanding 
            onArticlesSelected={handleDistroScoutArticlesSelected}
            onCheckNow={handleCheckNow}
            onStopChecking={handleStopChecking}
            isCheckingFeeds={isCheckingFeeds}
          />
        )}
        {activeTab === 'distro-scoopstream' && distroScoutStep === 'edit-send' && (
          <DistroScoutEditSend 
            articles={selectedArticles}
            onBack={handleBackToDistroScoutLanding}
            onEditArticle={handleEditArticle}
            onRemoveArticle={handleRemoveArticle}
            onSendToDistro={handleSendToDistro}
            onArticleStatusChange={handleArticleStatusChange}
          />
        )}
        {activeTab === 'sources' && (
          <SourceManager 
            sources={sources}
            onSourceAdded={handleSourceAdded}
            onSourceRemoved={handleSourceRemoved}
            refreshTrigger={refreshTrigger}
          />
        )}
        {activeTab === 'adk-web' && (
          <ADKWeb />
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

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/agent-test" element={<MainApp />} />
        <Route path="/sources" element={<MainApp />} />
        <Route path="/" element={<MainApp />} />
        <Route path="/scoopstream" element={<MainApp />} />
      </Routes>
    </Router>
  );
}

export default App;
