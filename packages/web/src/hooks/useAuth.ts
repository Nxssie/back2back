import { useState, useEffect } from "react";

interface User {
  id: string;
  username: string;
  avatar: string | null;
  isAdmin?: boolean;
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        setUser(data.user);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const login = () => {
    window.location.href = "/auth/discord";
  };

  const logout = () => {
    window.location.href = "/auth/logout";
  };

  return { user, loading, login, logout };
}
