import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GoogleLogin } from '@react-oauth/google';
import { useAuth } from '../context/AuthContext';

const LoginPage = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  
  const { login, signup, googleLogin } = useAuth();
  const navigate = useNavigate();

  const handleEmailAuth = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (isLogin) {
        await login(email, password);
      } else {
        await signup(name, email, password);
      }
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.detail || 'Authentication failed');
    }
  };

  const handleGoogleSuccess = async (credentialResponse) => {
    try {
      await googleLogin(credentialResponse.credential);
      navigate('/dashboard');
    } catch (err) {
      setError('Google authentication failed');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-900/50 border border-slate-800 rounded-2xl p-8 backdrop-blur-xl">
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold text-white mb-2">{isLogin ? 'Welcome Back' : 'Create Account'}</h2>
          <p className="text-slate-400">Secure access to your AI protection suite</p>
        </div>
        
        {error && <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded text-red-400 text-sm text-center">{error}</div>}

        <form onSubmit={handleEmailAuth} className="space-y-6">
          {!isLogin && (
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-2">Full Name</label>
              <input 
                type="text" 
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full bg-slate-950 border border-slate-800 rounded-brand px-4 py-3 text-white focus:border-brand-primary outline-none transition"
                placeholder="John Doe"
              />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-slate-400 mb-2">Email Address</label>
            <input 
              type="email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full bg-slate-950 border border-slate-800 rounded-brand px-4 py-3 text-white focus:border-brand-primary outline-none transition"
              placeholder="name@company.com"
            />
          </div>
          <div>
            <div className="flex justify-between mb-2">
              <label className="text-sm font-medium text-slate-400">Password</label>
              {isLogin && <a href="#" className="text-xs text-brand-primary hover:underline">Forgot password?</a>}
            </div>
            <input 
              type="password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full bg-slate-950 border border-slate-800 rounded-brand px-4 py-3 text-white focus:border-brand-primary outline-none transition"
              placeholder={isLogin ? "Enter your password" : "Create a strong password"}
            />
          </div>
          <button type="submit" className="w-full bg-brand-primary py-3 rounded-brand font-semibold text-white hover:bg-blue-600 transition">
            {isLogin ? 'Sign In →' : 'Sign Up →'}
          </button>
        </form>

        <div className="mt-6">
            <div className="relative">
                <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-800"></div></div>
                <div className="relative flex justify-center text-sm"><span className="px-2 bg-slate-900 text-slate-500">Or continue with</span></div>
            </div>
            <div className="mt-6 flex justify-center">
                <GoogleLogin
                    onSuccess={handleGoogleSuccess}
                    onError={() => setError('Google Login Failed')}
                    theme="filled_black"
                    shape="pill"
                />
            </div>
        </div>

        <div className="mt-8 text-center text-slate-500 text-sm">
          {isLogin ? "Don't have an account? " : "Already have an account? "} 
          <button onClick={() => { setIsLogin(!isLogin); setError(''); }} className="text-brand-primary font-medium hover:underline focus:outline-none">
            {isLogin ? 'Start free trial' : 'Sign In instead'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
