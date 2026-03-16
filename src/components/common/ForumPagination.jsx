import React from 'react';
import { Pagination } from 'react-bootstrap';
import { ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight } from 'lucide-react';
import './ForumPagination.css';

/**
 * Shared forum-styled pagination component.
 *
 * Props:
 *   currentPage  {number}   — active page (1-based)
 *   totalPages   {number}   — total number of pages
 *   onPageChange {function} — callback(newPage)
 *   className    {string?}  — extra class for the wrapper
 */
const ForumPagination = ({ currentPage, totalPages, onPageChange, className = '', centered = false }) => {
  if (totalPages <= 1) return null;

  const maxVisible = 5;
  let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  let endPage = Math.min(totalPages, startPage + maxVisible - 1);

  if (endPage - startPage + 1 < maxVisible) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }

  const pages = [];
  for (let i = startPage; i <= endPage; i++) {
    pages.push(i);
  }

  // Only show first/prev arrows if current range doesn't include 1
  // Only show next/last arrows if current range doesn't include last

  return (
    <Pagination className={`forum-pagination mb-0 ${centered ? 'forum-pagination-centered' : ''} ${className}`}>
      <Pagination.First
        className="first"
        onClick={() => onPageChange(1)}
        disabled={currentPage === 1}
      >
        <ChevronsLeft size={16} />
      </Pagination.First>
      <Pagination.Prev
        className="prev"
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        disabled={currentPage === 1}
      >
        <ChevronLeft size={16} />
      </Pagination.Prev>

      {startPage > 1 && <Pagination.Ellipsis disabled />}

      {pages.map((p) => (
        <Pagination.Item
          key={p}
          active={p === currentPage}
          onClick={() => onPageChange(p)}
        >
          {p}
        </Pagination.Item>
      ))}

      {endPage < totalPages && <Pagination.Ellipsis disabled />}

      <Pagination.Next
        className="next"
        onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
        disabled={currentPage === totalPages}
      >
        <ChevronRight size={16} />
      </Pagination.Next>
      <Pagination.Last
        className="last"
        onClick={() => onPageChange(totalPages)}
        disabled={currentPage === totalPages}
      >
        <ChevronsRight size={16} />
      </Pagination.Last>
    </Pagination>
  );
};

export default ForumPagination;
