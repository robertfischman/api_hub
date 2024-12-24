// Import necessary modules and utilities
import axios from "axios";
import { TodoInterface } from "../interfaces/todo";
// import { LocalStorage } from "../utils";

// Create an Axios instance for API requests
const apiClient = axios.create({
  baseURL: import.meta.env.VITE_SERVER_URI,
  withCredentials: true,
  timeout: 120000,
});

// funtions to create axios instance
const createTodoApi = (title: string, description: string) => {
  return apiClient.post(
    "/todos",
    { title, description },
    { headers: { "Content-Type": "application/json" } }
  );
};

const getAllTodos = () => {
  return apiClient.get("/todos");
};

const toggleTodoStatusApi = (todoId: string) => {
  return apiClient.patch(`/todos/toggle/status/${todoId}`);
};

const deleteTodoApi = (todoId: string) => {
  return apiClient.delete(`/todos/${todoId}`);
};

const editTodo = (
  todoId: string,
  todoData: { title: string; description: string }
) => {
  return apiClient.patch(`/todos/${todoId}`, todoData, {
    headers: { "Content-Type": "application/json" },
  });
};

export {
  createTodoApi,
  getAllTodos,
  toggleTodoStatusApi,
  deleteTodoApi,
  editTodo,
};
