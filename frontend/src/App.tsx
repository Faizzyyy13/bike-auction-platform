import React, { useState, useEffect } from 'react';

export default function App() {
  const [auctions, setAuctions] = useState<any[]>([]);
  
  // Grab the backend URL from Render's Environment Variables
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

  // 1. Fetch live auction data when the page loads (Example)
  useEffect(() => {
    const fetchAuctions = async () => {
      try {
        console.log(`Connecting to backend at: ${API_URL}`);
        // Uncomment the lines below once you know your exact backend API route
        // const response = await fetch(`${API_URL}/api/auctions`);
        // const data = await response.json();
        // setAuctions(data);
      } catch (error) {
        console.error("Failed to fetch auctions:", error);
      }
    };
    fetchAuctions();
  }, [API_URL]);

  // 2. The function that runs when you click the button
  const handlePlaceBid = async () => {
    console.log(`Bid button clicked! Sending request to: ${API_URL}`);
    
    try {
      // This is where you will send the POST request to your backend
      // Example:
      // await fetch(`${API_URL}/api/auctions/1/bid`, {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({ amount: 18600.00 })
      // });
      
      alert(`Attempted to send a bid to ${API_URL}! Check your console.`);
    } catch (error) {
      console.error("Bid failed:", error);
    }
  };

  return (
    <div style={{ padding: '40px', maxWidth: '1200px', margin: '0 auto' }}>
      <header style={{ borderBottom: '1px solid #334155', paddingBottom: '20px', marginBottom: '40px' }}>
        <h1 style={{ fontSize: '32px', fontWeight: '800', background: 'linear-gradient(135deg, #38bdf8, #818cf8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          🏍️ MotoAuction Platform
        </h1>
        <p style={{ color: '#94a3b8' }}>Real-time high-concurrency motorcycle bidding engine</p>
      </header>

      <main style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '24px' }}>
        <div style={{ background: '#1e293b', borderRadius: '16px', border: '1px solid #334155', padding: '24px' }}>
          <span style={{ background: '#0284c7', color: '#fff', fontSize: '12px', fontWeight: 600, padding: '4px 10px', borderRadius: '12px' }}>
            LIVE AUCTION
          </span>
          <h3 style={{ fontSize: '20px', margin: '16px 0 8px' }}>2023 Ducati Panigale V4 S</h3>
          <p style={{ color: '#94a3b8', fontSize: '14px' }}>1,103cc • 3,200 km • Excellent Condition</p>

          <div style={{ margin: '20px 0', padding: '16px', background: '#0f172a', borderRadius: '12px' }}>
            <div style={{ color: '#64748b', fontSize: '12px' }}>CURRENT HIGHEST BID</div>
            <div style={{ fontSize: '28px', fontWeight: '800', color: '#38bdf8' }}>$18,500.00</div>
            <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '4px' }}>14 total bids • Soft-close active</div>
          </div>

          {/* ADDED THE onClick HANDLER HERE */}
          <button 
            onClick={handlePlaceBid} 
            style={{ width: '100%', background: 'linear-gradient(135deg, #0284c7, #4f46e5)', color: '#fff', border: 'none', padding: '14px', borderRadius: '10px', fontWeight: '700', fontSize: '16px', cursor: 'pointer' }}
          >
            Place Bid ($18,600.00)
          </button>
        </div>
      </main>
    </div>
  );
}
