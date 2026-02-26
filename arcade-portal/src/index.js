import React from "react";
import ReactDOM from "react-dom";
import "antd/dist/antd.css";
import "./index.css";
import App from "./App";
import Home from "./home";
import ControllerPage from "./controller";
import {AppDataProvider} from './store'

import * as serviceWorker from "./serviceWorker";
import { BrowserRouter as Router, Switch, Route } from "react-router-dom";
const app = (
  <AppDataProvider>
    <Router>
      <Switch>
        <Route path="/game/:id">
          <App />
        </Route>
        <Route path="/controller/:code?">
          <ControllerPage />
        </Route>
        <Route exact path="/">
          <Home />
        </Route>
      </Switch>
    </Router>
  </AppDataProvider>
);
ReactDOM.render(app, document.getElementById("root"));

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: https://bit.ly/CRA-PWA
serviceWorker.unregister();
