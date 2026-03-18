import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

function shortId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

const Dashboard = () => {
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
    <div className="min-h-screen bg-slate-950 text-white flex flex-col">
      <header className="px-8 py-4 flex justify-between items-center">
        <Link to="/" className="flex items-center gap-2 font-bold text-xl hover:text-brand-primary transition">
          <div className="w-8 h-8 bg-brand-primary rounded flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04M12 21.48V22M12 21.48c-.766 0-1.521-.07-2.257-.204M12 21.48c.766 0 1.521-.07 2.257-.204m-4.514-.408l-.311 1.242m4.825-1.242l.311 1.242M9.621 19.74H12m0 0H14.379m-4.758 0L9 21.48M14.379 19.74L15 21.48" /></svg>
          </div>
          Meet
        </Link>
        <div className="flex items-center gap-6 text-slate-400">
          <span>{new Date().toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', weekday: 'short', month: 'short', day: 'numeric' })}</span>
          <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-sm font-bold text-white">JD</div>
        </div>
      </header>
      
      <main className="flex-1 flex items-center px-20">
        <div className="w-1/2">
          <h1 className="text-6xl font-bold mb-8">
            Premium video meetings. <br />
            <span className="text-brand-primary">Now free for everyone.</span>
          </h1>
          <p className="text-slate-400 text-xl mb-12 max-w-lg">
            We re-engineered the service we built for secure business meetings to make it free and available for all.
          </p>
          <div className="flex gap-6">
            <Link to={`/room/${shortId()}`} className="bg-brand-primary px-6 py-3 rounded-brand font-semibold flex items-center gap-2 hover:bg-blue-600 transition">
              New meeting
            </Link>
            <div className="flex bg-slate-900 border border-slate-800 rounded-brand p-1">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && join()}
                placeholder="Enter a code or link"
                className="bg-transparent px-4 outline-none w-64"
              />
            </div>
            <button onClick={join} className="text-slate-400 font-semibold hover:text-white">Join</button>
          </div>
        </div>
        <div className="w-1/2 flex flex-col items-center">
          <div className="relative w-80 h-80 rounded-full overflow-hidden border-8 border-slate-900 shadow-2xl">
            <img src="https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&w=400" className="w-full h-full object-cover" />
          </div>
          <h3 className="mt-8 text-2xl font-bold">Get a link you can share</h3>
          <p className="text-slate-400 mt-2 text-center">Click New meeting to get a link you can send to people.</p>
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
