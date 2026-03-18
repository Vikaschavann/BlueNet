import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

function shortId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

const LandingPage = () => {
  const navigate = useNavigate();
  const [code, setCode] = useState('');

  const join = () => {
    const raw = code.trim();
    if (!raw) return;
    const m = raw.match(/\/room\/([a-z0-9]+)/i);
    const room = (m?.[1] || raw).toLowerCase();
    navigate(`/room/${room}`);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white font-sans">
      {/* Navigation */}
      <nav className="flex items-center justify-between px-8 py-6 max-w-7xl mx-auto">
        <div className="flex items-center gap-2 text-xl font-bold">
          <div className="w-8 h-8 bg-brand-primary rounded flex items-center justify-center">
             <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04M12 21.48V22M12 21.48c-.766 0-1.521-.07-2.257-.204M12 21.48c.766 0 1.521-.07 2.257-.204m-4.514-.408l-.311 1.242m4.825-1.242l.311 1.242M9.621 19.74H12m0 0H14.379m-4.758 0L9 21.48M14.379 19.74L15 21.48" /></svg>
          </div>
          Silent Guardian AI
        </div>
        <div className="hidden md:flex items-center gap-8 text-slate-400">
          <a href="#" className="hover:text-white">Features</a>
          <a href="#" className="hover:text-white">Security</a>
          <a href="#" className="hover:text-white">Pricing</a>
          <a href="#" className="hover:text-white">Enterprise</a>
        </div>
        <div className="flex items-center gap-4">
          <Link to="/login" className="px-4 py-2 hover:bg-white/10 rounded">Sign In</Link>
          <Link to="/dashboard" className="px-6 py-2 bg-brand-primary rounded-brand font-medium">Join Meeting</Link>
        </div>
      </nav>

      {/* Hero Section */}
      <main className="max-w-7xl mx-auto px-8 py-20 grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <span className="text-brand-primary text-xs font-bold tracking-widest uppercase mb-4 block">End-to-End Encrypted</span>
          <h1 className="text-6xl font-bold leading-tight mb-6">
            Secure, AI-Moderated <br />
            <span className="text-brand-primary">Video Calls</span>
          </h1>
          <p className="text-slate-400 text-lg mb-10 max-w-md">
            Experience the next generation of private communication. Real-time AI moderation protects your meetings from disruptions while ensuring absolute data privacy.
          </p>
          <div className="flex items-center gap-4">
            <Link to={`/room/${shortId()}`} className="px-8 py-4 bg-brand-primary rounded-brand font-semibold text-lg hover:bg-blue-600 transition">Start a meeting</Link>
            <div className="flex items-center bg-slate-900 border border-slate-800 rounded-brand p-1">
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && join()}
                placeholder="Enter a code or link"
                className="bg-transparent px-4 py-2 outline-none"
              />
              <button onClick={join} className="px-4 py-2 text-slate-400 font-medium hover:text-white">Join</button>
            </div>
          </div>
        </div>
        <div className="relative">
          <div className="rounded-2xl overflow-hidden border-4 border-slate-800 shadow-2xl">
            <img src="https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?auto=format&fit=crop&w=800" alt="Video Call Preview" className="w-full h-auto" />
            <div className="absolute top-4 right-4 bg-blue-500/80 backdrop-blur-sm px-3 py-1 rounded-full text-[10px] flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span>
              AI GUARD ACTIVE
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default LandingPage;
