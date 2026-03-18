import React, { createContext, useContext, useState, useEffect } from 'react';
import axios from 'axios';

const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    const checkToken = () => {
        const token = localStorage.getItem('token');
        const userData = localStorage.getItem('user');
        if (token && userData) {
            try {
                setUser(JSON.parse(userData));
            } catch (e) {
                // Invalid JSON
            }
        }
        setLoading(false);
    };

    useEffect(() => {
        checkToken();
    }, []);

    const login = async (email, password) => {
        const response = await axios.post('http://localhost:8000/auth/login', { email, password });
        const { access_token, name, email: userEmail } = response.data;
        
        localStorage.setItem('token', access_token);
        const userData = { name, email: userEmail };
        localStorage.setItem('user', JSON.stringify(userData));
        setUser(userData);
        return userData;
    };

    const signup = async (name, email, password) => {
        const response = await axios.post('http://localhost:8000/auth/signup', { name, email, password });
        const { access_token, name: userName, email: userEmail } = response.data;
        
        localStorage.setItem('token', access_token);
        const userData = { name: userName, email: userEmail };
        localStorage.setItem('user', JSON.stringify(userData));
        setUser(userData);
        return userData;
    };

    const googleLogin = async (credential) => {
        const response = await axios.post('http://localhost:8000/auth/google', { token: credential });
        const { access_token, name, email } = response.data;
        
        localStorage.setItem('token', access_token);
        const userData = { name, email };
        localStorage.setItem('user', JSON.stringify(userData));
        setUser(userData);
        return userData;
    };

    const logout = () => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        setUser(null);
    };

    return (
        <AuthContext.Provider value={{ user, login, signup, googleLogin, logout, loading }}>
            {children}
        </AuthContext.Provider>
    );
};
