import { Request, Response, NextFunction, RequestHandler } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import User, { IUser } from '../models/userModel';
import { validatePassword, validateEmail } from '../utils/validators';

export const register: RequestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { username, email, numberPhone, password, confirmPassword } = req.body;

    if (!validateEmail(email)) {
        res.status(400).json({ message: 'Invalid email format' });
        return;
    }

    if (!validatePassword(password)) {
        res.status(400).json({ message: 'Password does not meet criteria' });
        return;
    }

    if (password !== confirmPassword) {
        res.status(400).json({ message: 'Passwords do not match' });
        return;
    }

    try {
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            res.status(400).json({ message: 'Email already in use' });
            return;
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser: IUser = new User({ username, email, numberPhone, password: hashedPassword });
        await newUser.save();

        res.status(201).json({ message: 'User registered successfully' });
        return;
    } catch (error) {
        res.status(500).json({ message: 'Server error', error });
    }
};

export const login: RequestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { username, email, password } = req.body;

    try {
        const user = await User.findOne({
            $or: [{ email: req.body.email }, { username: req.body.username }]
        });

        if (!user) {
            res.status(400).json({ message: 'Invalid email/username or password' });
            return;
        }

        const isMatch = await bcrypt.compare(req.body.password, user.password);
        if (!isMatch) {
            res.status(400).json({ message: 'Invalid email/username or password' });
            return;
        }

        jwt.sign({ id: user._id }, 'userLogin', { expiresIn: '1h' });
        res.status(200).json({ message: 'User logged in successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error });
    }
};
