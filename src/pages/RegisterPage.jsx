import React from 'react';
import { useAuth } from '../contexts/AuthProvider';
import { Navigate, useLocation } from 'react-router-dom';
import { Container, Card } from 'react-bootstrap';
import RegisterForm from '../components/auth/RegisterForm';

const RegisterPage = () => {
  const { user } = useAuth();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/';

  if (user) {
    return <Navigate to={from} replace />;
  }

  return (
    <Container className="d-flex align-items-center justify-content-center vh-100">
      <Card style={{ maxWidth: '440px', width: '100%' }} className="p-4 shadow border-0 rounded-4">
        <Card.Body>
          <RegisterForm />
        </Card.Body>
      </Card>
    </Container>
  );
};

export default RegisterPage;
